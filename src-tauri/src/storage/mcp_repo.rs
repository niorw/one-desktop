

use crate::mcp::model::*;
use crate::storage::connection::DbConnection;
use crate::storage::repository::Repository;
use crate::storage::secrets::{split_env, SecretsRepository};
use rusqlite::{params, Result as SqliteResult};
use serde_json;
use std::collections::HashMap;

pub struct McpServerRepository<'a> {
    db: &'a DbConnection,
}

impl<'a> McpServerRepository<'a> {
    pub fn new(db: &'a DbConnection) -> Self {
        Self { db }
    }

    pub fn set_enabled(&self, id: &str, enabled: bool) -> SqliteResult<()> {
        let now = chrono::Utc::now().to_rfc3339();
        let status = if enabled {
            McpStatus::Enabled
        } else {
            McpStatus::Disabled
        };
        self.db.with_conn_mut(|c| {
            c.execute(
                "UPDATE mcp_servers SET enabled=?1, status=?2, updated_at=?3 WHERE id=?4",
                params![enabled, status.as_str(), now, id],
            )
            .map(|_| ())
        })
    }

    pub fn set_status(&self, id: &str, status: McpStatus) -> SqliteResult<()> {
        let now = chrono::Utc::now().to_rfc3339();
        self.db.with_conn_mut(|c| {
            c.execute(
                "UPDATE mcp_servers SET status=?1, updated_at=?2 WHERE id=?3",
                params![status.as_str(), now, id],
            )
            .map(|_| ())
        })
    }

    pub fn record_success(&self, id: &str, caps: &McpCapabilities) -> SqliteResult<()> {
        let now = chrono::Utc::now().to_rfc3339();
        let caps_json = serde_json::to_string(caps).unwrap_or_else(|_| "{}".to_string());
        self.db.with_conn_mut(|c| {
            c.execute(
                "UPDATE mcp_servers SET status='enabled', capabilities=?1, error=NULL, updated_at=?2 WHERE id=?3",
                params![caps_json, now, id],
            )
            .map(|_| ())
        })
    }

    pub fn record_error(&self, id: &str, err: &str) -> SqliteResult<()> {
        let now = chrono::Utc::now().to_rfc3339();
        self.db.with_conn_mut(|c| {
            c.execute(
                "UPDATE mcp_servers SET status='error', error=?1, updated_at=?2 WHERE id=?3",
                params![err, now, id],
            )
            .map(|_| ())
        })
    }
}

impl<'a> Repository<McpServer, CreateMcpServerPayload, ()> for McpServerRepository<'a> {
    fn create(&self, p: CreateMcpServerPayload) -> SqliteResult<McpServer> {
        let now = chrono::Utc::now().to_rfc3339();
        let args_json = serde_json::to_string(&p.args).unwrap_or_else(|_| "[]".to_string());
        
        let (keep_env, secret_env) = split_env(&p.env);
        let env_json = serde_json::to_string(&keep_env).unwrap_or_else(|_| "{}".to_string());
        let server = McpServer {
            id: p.id,
            name: p.name,
            transport: p.transport.clone(),
            command: p.command.clone(),
            args: p.args,
            env: p.env,
            url: p.url.clone(),
            enabled: p.enabled,
            status: if p.enabled {
                McpStatus::Enabled
            } else {
                McpStatus::Disabled
            },
            capabilities: McpCapabilities::default(),
            error: None,
            created_at: now.clone(),
            updated_at: now,
        };
        
        let scope = format!("mcp:{}", server.id);
        self.db.with_conn_mut(|c| {
            c.execute(
                "INSERT INTO mcp_servers \
                 (id,name,transport,command,args,env,url,enabled,status,capabilities,error,created_at,updated_at) \
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'{}',NULL,?10,?11)",
                params![
                    server.id,
                    server.name,
                    server.transport.as_str(),
                    server.command,
                    args_json,
                    env_json,
                    server.url,
                    server.enabled,
                    server.status.as_str(),
                    server.created_at,
                    server.updated_at,
                ],
            )
            .map(|_| ())
        })?;
        
        SecretsRepository::new(self.db).replace_scope(&scope, &secret_env)?;
        Ok(server)
    }

    fn find_by_id(&self, id: &str) -> SqliteResult<Option<McpServer>> {
        let server = self.db.with_conn(|c| {
            let mut stmt = c.prepare(
                "SELECT id,name,transport,command,args,env,url,enabled,status,capabilities,error,created_at,updated_at \
                 FROM mcp_servers WHERE id=?1",
            )?;
            let mut rows = stmt.query_map(params![id], row_to_server)?;
            match rows.next() {
                Some(Ok(s)) => Ok(Some(s)),
                _ => Ok(None),
            }
        })?;
        
        match server {
            Some(s) => Ok(Some(self.hydrate(s)?)),
            None => Ok(None),
        }
    }

    fn find_all(&self, _q: ()) -> SqliteResult<Vec<McpServer>> {
        let list: Vec<McpServer> = self.db.with_conn(|c| {
            let mut stmt = c.prepare(
                "SELECT id,name,transport,command,args,env,url,enabled,status,capabilities,error,created_at,updated_at \
                 FROM mcp_servers ORDER BY updated_at DESC",
            )?;
            let list = stmt
                .query_map([], row_to_server)?
                .filter_map(|r| r.ok())
                .collect();
            Ok(list)
        })?;
        list.into_iter().map(|s| self.hydrate(s)).collect()
    }

    fn delete(&self, id: &str) -> SqliteResult<()> {
        self.db.with_conn_mut(|c| {
            c.execute("DELETE FROM mcp_servers WHERE id=?1", params![id])
                .map(|_| ())
        })?;
        
        SecretsRepository::new(self.db).delete_scope(&format!("mcp:{}", id))
    }
}

impl<'a> McpServerRepository<'a> {
    
    fn hydrate(&self, mut server: McpServer) -> SqliteResult<McpServer> {
        let secrets = SecretsRepository::new(self.db)
            .read_scope(&format!("mcp:{}", server.id))?;
        for (k, v) in secrets {
            server.env.insert(k, v);
        }
        Ok(server)
    }
}

fn row_to_server(row: &rusqlite::Row) -> rusqlite::Result<McpServer> {
    let transport = McpTransport::from_str(&row.get::<_, String>(2)?);
    let args_json: String = row.get(4)?;
    let env_json: String = row.get(5)?;
    let caps_json: String = row.get(9)?;
    let args: Vec<String> = serde_json::from_str(&args_json).unwrap_or_default();
    let env: HashMap<String, String> = serde_json::from_str(&env_json).unwrap_or_default();
    let caps: McpCapabilities = serde_json::from_str(&caps_json).unwrap_or_default();
    Ok(McpServer {
        id: row.get(0)?,
        name: row.get(1)?,
        transport,
        command: row.get(3)?,
        args,
        env,
        url: row.get(6)?,
        enabled: row.get(7)?,
        status: McpStatus::from_str(&row.get::<_, String>(8)?),
        capabilities: caps,
        error: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::connection::DbConnection;
    use std::collections::HashMap;

    fn tmp_db(name: &str) -> DbConnection {
        let dir = std::env::temp_dir().join(format!("od_f13_{}_{}", std::process::id(), name));
        std::fs::create_dir_all(&dir).unwrap();
        DbConnection::open(&dir).unwrap()
    }

    fn payload(name: &str, env: HashMap<String, String>) -> CreateMcpServerPayload {
        CreateMcpServerPayload {
            id: format!("srv_{}", name),
            name: name.to_string(),
            transport: McpTransport::Stdio,
            command: Some("python3".to_string()),
            args: vec![],
            env,
            url: None,
            enabled: true,
        }
    }

    #[test]
    fn secrets_roundtrip_no_plaintext_in_db() {
        let db = tmp_db("roundtrip");
        let mut env = HashMap::new();
        env.insert("OPENAI_API_KEY".to_string(), "sk-super-secret-123".to_string());
        env.insert("PYTHONUNBUFFERED".to_string(), "1".to_string());
        let repo = McpServerRepository::new(&db);
        let created = repo.create(payload("rt", env)).unwrap();

        
        assert_eq!(created.env.get("OPENAI_API_KEY").map(|s| s.as_str()), Some("sk-super-secret-123"));

        
        let raw: String = db
            .with_conn(|c| c.query_row("SELECT env FROM mcp_servers WHERE id='srv_rt'", [], |r| r.get(0)))
            .unwrap();
        assert!(!raw.contains("OPENAI_API_KEY"), "mcp_servers.env 不应含敏感键: {}", raw);
        assert!(!raw.contains("sk-super-secret-123"));

        
        let sec: String = db
            .with_conn(|c| c.query_row("SELECT value FROM secrets WHERE scope='mcp:srv_rt' AND key='OPENAI_API_KEY'", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(sec, "sk-super-secret-123");

        
        let read = repo.find_by_id("srv_rt").unwrap().unwrap();
        assert_eq!(read.env.get("OPENAI_API_KEY").map(|s| s.as_str()), Some("sk-super-secret-123"));
        assert_eq!(read.env.get("PYTHONUNBUFFERED").map(|s| s.as_str()), Some("1"));
    }

    #[test]
    fn delete_cleans_secrets() {
        let db = tmp_db("delete");
        let mut env = HashMap::new();
        env.insert("TOKEN".to_string(), "t-abc".to_string());
        let repo = McpServerRepository::new(&db);
        repo.create(payload("del", env)).unwrap();
        let count: i64 = db
            .with_conn(|c| c.query_row("SELECT COUNT(*) FROM secrets WHERE scope='mcp:srv_del'", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(count, 1);
        repo.delete("srv_del").unwrap();
        let after: i64 = db
            .with_conn(|c| c.query_row("SELECT COUNT(*) FROM secrets WHERE scope='mcp:srv_del'", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(after, 0, "删除 server 应级联清理 secrets");
    }

    #[test]
    fn dto_redacts_sensitive_env() {
        let db = tmp_db("dto");
        let mut env = HashMap::new();
        env.insert("API_KEY".to_string(), "sk-abcdef123456".to_string());
        env.insert("PORT".to_string(), "8080".to_string());
        let srv = McpServerRepository::new(&db).create(payload("dto", env)).unwrap();
        let dto = srv.to_dto();
        assert_eq!(dto.env.get("PORT").map(|s| s.as_str()), Some("8080"));
        assert_eq!(dto.env.get("API_KEY").map(|s| s.as_str()), Some("sk••••56"));
        assert!(!dto.env.get("API_KEY").unwrap().contains("abcdef123456"));
    }
}

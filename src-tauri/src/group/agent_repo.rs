

use crate::group::agent_profile::{
    default_isolation, default_permission_mode, default_provider, default_token_budget,
    AgentProfile, AgentProfileExt, CreateAgentProfilePayload, UpdateAgentProfilePayload,
};
use crate::storage::connection::DbConnection;
use crate::storage::repository::Repository;
use rusqlite::{params, Result as SqliteResult};

pub struct AgentProfileRepository<'a> {
    db: &'a DbConnection,
}

impl<'a> AgentProfileRepository<'a> {
    pub fn new(db: &'a DbConnection) -> Self {
        Self { db }
    }

    
    
    pub fn update(&self, id: &str, p: UpdateAgentProfilePayload) -> SqliteResult<AgentProfile> {
        let current = self
            .find_by_id(id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        let name = p.name.unwrap_or(current.name);
        let model = p.model.unwrap_or(current.model);
        let system_prompt = p.system_prompt.unwrap_or(current.system_prompt);
        let capabilities = p.capabilities.unwrap_or(current.capabilities);
        let skills = p.skills.unwrap_or(current.skills);
        let mcp = p.mcp.unwrap_or(current.mcp);
        let tools = p.tools.unwrap_or(current.tools);
        let plugins = p.plugins.unwrap_or(current.plugins);
        let disallowed_tools = p.disallowed_tools.unwrap_or(current.disallowed_tools);
        let permission_mode = p.permission_mode.unwrap_or(current.permission_mode);
        let max_turns = p.max_turns.unwrap_or(current.max_turns);
        let isolation = p.isolation.unwrap_or(current.isolation);

        self.db.with_conn_mut(|conn| {
            conn.execute(
                "UPDATE agents SET name=?1, model=?2, system_prompt=?3, \
                 capabilities=?4, skills=?5, mcp=?6, tools=?7, plugins=?8, \
                 disallowed_tools=?9, permission_mode=?10, max_turns=?11, isolation=?12 WHERE id=?13",
                params![
                    name,
                    model,
                    system_prompt,
                    serde_json::to_string(&capabilities).unwrap_or_else(|_| "[]".into()),
                    serde_json::to_string(&skills).unwrap_or_else(|_| "[]".into()),
                    serde_json::to_string(&mcp).unwrap_or_else(|_| "[]".into()),
                    serde_json::to_string(&tools).unwrap_or_else(|_| "[]".into()),
                    serde_json::to_string(&plugins).unwrap_or_else(|_| "[]".into()),
                    serde_json::to_string(&disallowed_tools).unwrap_or_else(|_| "[]".into()),
                    permission_mode,
                    max_turns,
                    isolation,
                    id,
                ],
            )
        })?;
        self.find_by_id(id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)
    }
}

fn map_row(row: &rusqlite::Row) -> SqliteResult<AgentProfile> {
    Ok(AgentProfile {
        id: row.get(0)?,
        name: row.get(1)?,
        model: row.get(2)?,
        system_prompt: row.get(3)?,
        capabilities: serde_json::from_str(&row.get::<_, String>(4)?).unwrap_or_default(),
        skills: serde_json::from_str(&row.get::<_, String>(5)?).unwrap_or_default(),
        mcp: serde_json::from_str(&row.get::<_, String>(6)?).unwrap_or_default(),
        tools: serde_json::from_str(&row.get::<_, String>(7)?).unwrap_or_default(),
        created_at: row.get(8)?,
        token_budget: row.get(9).unwrap_or_else(|_| default_token_budget()),
        provider: row.get(10).unwrap_or_else(|_| default_provider()),
        executor: row.get(11).unwrap_or(None),
        disallowed_tools: serde_json::from_str(&row.get::<_, String>(12).unwrap_or_default())
            .unwrap_or_default(),
        permission_mode: row
            .get(13)
            .unwrap_or_else(|_| default_permission_mode()),
        max_turns: row.get(14).unwrap_or(0),
        isolation: row.get(15).unwrap_or_else(|_| default_isolation()),
        plugins: serde_json::from_str(&row.get::<_, String>(16).unwrap_or_default()).unwrap_or_default(),
    })
}

impl<'a> Repository<AgentProfile, CreateAgentProfilePayload, ()> for AgentProfileRepository<'a> {
    fn create(&self, p: CreateAgentProfilePayload) -> SqliteResult<AgentProfile> {
        self.create_full(
            p,
            AgentProfileExt {
                disallowed_tools: vec![],
                plugins: vec![],
                permission_mode: default_permission_mode(),
                max_turns: 0,
                isolation: default_isolation(),
            },
        )
    }

    fn find_by_id(&self, id: &str) -> SqliteResult<Option<AgentProfile>> {
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id,name,model,system_prompt,capabilities,skills,mcp,tools,created_at,token_budget,provider,executor,disallowed_tools,permission_mode,max_turns,isolation,plugins \
                 FROM agents WHERE id = ?1",
            )?;
            let mut rows = stmt.query_map(params![id], map_row)?;
            match rows.next() {
                Some(Ok(p)) => Ok(Some(p)),
                _ => Ok(None),
            }
        })
    }

    fn find_all(&self, _query: ()) -> SqliteResult<Vec<AgentProfile>> {
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id,name,model,system_prompt,capabilities,skills,mcp,tools,created_at,token_budget,provider,executor,disallowed_tools,permission_mode,max_turns,isolation,plugins \
                 FROM agents ORDER BY created_at DESC",
            )?;
            let items = stmt
                .query_map([], map_row)?
                .filter_map(|r| r.ok())
                .collect();
            Ok(items)
        })
    }

    fn delete(&self, id: &str) -> SqliteResult<()> {
        self.db.with_conn_mut(|conn| {
            conn.execute("DELETE FROM agents WHERE id = ?1", params![id])?;
            Ok(())
        })
    }
}

impl<'a> AgentProfileRepository<'a> {
    
    
    pub fn create_full(
        &self,
        p: CreateAgentProfilePayload,
        ext: AgentProfileExt,
    ) -> SqliteResult<AgentProfile> {
        let id = format!("ag_{}", uuid::Uuid::new_v4().simple());
        let now = chrono::Utc::now().timestamp();
        self.db.with_conn_mut(|conn| {
            conn.execute(
                "INSERT INTO agents (id,name,model,system_prompt,capabilities,skills,mcp,tools,created_at,token_budget,provider,executor,disallowed_tools,permission_mode,max_turns,isolation,plugins)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)",
                params![
                    id,
                    p.name,
                    p.model,
                    p.system_prompt,
                    serde_json::to_string(&p.capabilities).unwrap_or_else(|_| "[]".into()),
                    serde_json::to_string(&p.skills).unwrap_or_else(|_| "[]".into()),
                    serde_json::to_string(&p.mcp).unwrap_or_else(|_| "[]".into()),
                    serde_json::to_string(&p.tools).unwrap_or_else(|_| "[]".into()),
                    now,
                    default_token_budget(),
                    default_provider(),
                    Option::<String>::None,
                    serde_json::to_string(&ext.disallowed_tools).unwrap_or_else(|_| "[]".into()),
                    ext.permission_mode,
                    ext.max_turns,
                    ext.isolation,
                    serde_json::to_string(&ext.plugins).unwrap_or_else(|_| "[]".into()),
                ],
            )
        })?;
        self.find_by_id(&id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::connection::DbConnection;
    use std::path::PathBuf;

    fn tmp_db() -> DbConnection {
        let dir = PathBuf::from(std::env::temp_dir())
            .join(format!("od_test_{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).ok();
        DbConnection::open(&dir).unwrap()
    }

    #[test]
    fn agent_profile_roundtrip() {
        let db = tmp_db();
        let repo = AgentProfileRepository::new(&db);
        let created = repo
            .create(CreateAgentProfilePayload {
                name: "researcher".into(),
                model: "deepseek-chat".into(),
                system_prompt: "You research.".into(),
                capabilities: vec!["search".into(), "summarize".into()],
                skills: vec![],
                mcp: vec![],
                tools: vec!["fs".into()],
            })
            .unwrap();
        let got = repo.find_by_id(&created.id).unwrap().unwrap();
        assert_eq!(got.name, "researcher");
        assert_eq!(
            got.capabilities,
            vec!["search".to_string(), "summarize".to_string()]
        );
        assert_eq!(got.tools, vec!["fs".to_string()]);

        let all = repo.find_all(()).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, created.id);

        repo.delete(&created.id).unwrap();
        assert!(repo.find_by_id(&created.id).unwrap().is_none());
    }

    #[test]
    fn agent_profile_update_partial() {
        let db = tmp_db();
        let repo = AgentProfileRepository::new(&db);
        let created = repo
            .create(CreateAgentProfilePayload {
                name: "researcher".into(),
                model: "deepseek-chat".into(),
                system_prompt: "You research.".into(),
                capabilities: vec!["search".into()],
                skills: vec![],
                mcp: vec![],
                tools: vec!["fs".into()],
            })
            .unwrap();

        
        let updated = repo
            .update(
                &created.id,
                UpdateAgentProfilePayload {
                    name: Some("lead-researcher".into()),
                    capabilities: Some(vec!["search".into(), "summarize".into()]),
                    ..Default::default()
                },
            )
            .unwrap();

        assert_eq!(updated.name, "lead-researcher");
        assert_eq!(
            updated.capabilities,
            vec!["search".to_string(), "summarize".to_string()]
        );
        
        assert_eq!(updated.model, "deepseek-chat");
        assert_eq!(updated.system_prompt, "You research.");
        assert_eq!(updated.tools, vec!["fs".to_string()]);

        
        assert!(repo
            .update(
                "ag_missing",
                UpdateAgentProfilePayload {
                    name: Some("x".into()),
                    ..Default::default()
                }
            )
            .is_err());
    }
}

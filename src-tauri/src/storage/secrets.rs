









use crate::storage::connection::DbConnection;
use rusqlite::{params, Result as SqliteResult};
use std::collections::HashMap;



pub fn is_sensitive_key(name: &str) -> bool {
    let n = name.to_lowercase();
    ["key", "token", "secret", "password", "passwd", "auth", "credential", "api_key", "apikey"]
        .iter()
        .any(|k| n.contains(k))
}



pub fn redact(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    if chars.len() <= 6 {
        return "••••".to_string();
    }
    let head: String = chars[..2].iter().collect();
    let tail: String = chars[chars.len() - 2..].iter().collect();
    format!("{}••••{}", head, tail)
}



pub fn redact_sensitive_args(args: &str) -> String {
    let v: serde_json::Value = match serde_json::from_str(args) {
        Ok(v) => v,
        Err(_) => return args.to_string(),
    };
    redact_value(v).to_string()
}

fn redact_value(v: serde_json::Value) -> serde_json::Value {
    match v {
        serde_json::Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (k, val) in map {
                if is_sensitive_key(&k) {
                    out.insert(k, serde_json::json!("***"));
                } else {
                    out.insert(k, redact_value(val));
                }
            }
            serde_json::Value::Object(out)
        }
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.into_iter().map(redact_value).collect())
        }
        other => other,
    }
}


pub fn split_env(env: &HashMap<String, String>) -> (HashMap<String, String>, HashMap<String, String>) {
    let mut keep = HashMap::new();
    let mut secret = HashMap::new();
    for (k, v) in env {
        if is_sensitive_key(k) {
            secret.insert(k.clone(), v.clone());
        } else {
            keep.insert(k.clone(), v.clone());
        }
    }
    (keep, secret)
}


pub struct SecretsRepository<'a> {
    db: &'a DbConnection,
}

impl<'a> SecretsRepository<'a> {
    pub fn new(db: &'a DbConnection) -> Self {
        Self { db }
    }

    
    pub fn replace_scope(&self, scope: &str, values: &HashMap<String, String>) -> SqliteResult<()> {
        let now = chrono::Utc::now().to_rfc3339();
        self.db.with_conn_mut(|c| {
            let tx = c.transaction()?;
            tx.execute("DELETE FROM secrets WHERE scope = ?1", params![scope])?;
            for (k, v) in values {
                tx.execute(
                    "INSERT OR REPLACE INTO secrets (id, scope, key, value, created_at) \
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![format!("{}:{}", scope, k), scope, k, v, now],
                )?;
            }
            tx.commit()?;
            Ok(())
        })
    }

    
    pub fn read_scope(&self, scope: &str) -> SqliteResult<HashMap<String, String>> {
        self.db.with_conn(|c| {
            let mut stmt = c.prepare("SELECT key, value FROM secrets WHERE scope = ?1")?;
            let rows = stmt.query_map(params![scope], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            let mut out = HashMap::new();
            for row in rows.flatten() {
                out.insert(row.0, row.1);
            }
            Ok(out)
        })
    }

    
    pub fn delete_scope(&self, scope: &str) -> SqliteResult<()> {
        self.db
            .with_conn_mut(|c| c.execute("DELETE FROM secrets WHERE scope = ?1", params![scope]).map(|_| ()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sensitive_key_detection() {
        assert!(is_sensitive_key("API_KEY"));
        assert!(is_sensitive_key("OPENAI_API_KEY"));
        assert!(is_sensitive_key("access_token"));
        assert!(is_sensitive_key("client_secret"));
        assert!(is_sensitive_key("password"));
        assert!(is_sensitive_key("Authorization"));
        assert!(!is_sensitive_key("PYTHONUNBUFFERED"));
        assert!(!is_sensitive_key("MODEL"));
        assert!(!is_sensitive_key("PORT"));
    }

    #[test]
    fn redact_keeps_edges() {
        assert_eq!(redact("sk-abcdef123456"), "sk••••56");
        assert_eq!(redact("short"), "••••");
        assert_eq!(redact(""), "••••");
    }

    #[test]
    fn split_env_partitions_sensitive() {
        let mut env = HashMap::new();
        env.insert("API_KEY".to_string(), "sk-secret".to_string());
        env.insert("PYTHONUNBUFFERED".to_string(), "1".to_string());
        let (keep, secret) = split_env(&env);
        assert!(keep.contains_key("PYTHONUNBUFFERED"));
        assert!(!keep.contains_key("API_KEY"));
        assert_eq!(secret.get("API_KEY").map(|s| s.as_str()), Some("sk-secret"));
    }

    #[test]
    fn redact_sensitive_args_masks_keys() {
        let args = r#"{"command":"ls","API_KEY":"sk-leak","token":"t123"}"#;
        let out = redact_sensitive_args(args);
        assert!(out.contains("\"API_KEY\":\"***\""));
        assert!(out.contains("\"token\":\"***\""));
        assert!(out.contains("\"command\":\"ls\""));
        
        assert!(!out.contains("sk-leak"));
        assert!(!out.contains("t123"));
    }
}













use crate::agent::ports::{Blackboard, BlackboardError};
use crate::group::topology::{Channel, Endpoint};
use crate::group::topology_router::enforce_topology;
use crate::storage::connection::DbConnection;
use rusqlite::{OptionalExtension, params};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};


pub struct SqliteBlackboard {
    db: Arc<DbConnection>,
}

impl SqliteBlackboard {
    pub fn new(db: Arc<DbConnection>) -> Self {
        Self { db }
    }
}

impl Blackboard for SqliteBlackboard {
    fn read(&self, session_id: &str, key: &str) -> Option<(String, u64)> {
        self.db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT value, version FROM blackboard WHERE session_id = ?1 AND key = ?2",
                    params![session_id, key],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as u64)),
                )
            })
            .ok()
    }

    fn list(&self, session_id: &str) -> Vec<(String, String, u64)> {
        self.db
            .with_conn(|conn| {
                let mut stmt = conn.prepare(
                    "SELECT key, value, version FROM blackboard WHERE session_id = ?1 \
                     ORDER BY key ASC",
                )?;
                let rows = stmt.query_map(params![session_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)? as u64,
                    ))
                })?;
                let mut out = Vec::new();
                for r in rows {
                    out.push(r?);
                }
                Ok(out)
            })
            .unwrap_or_default()
    }

    fn cas_write(
        &self,
        session_id: &str,
        key: &str,
        value: &str,
        expected_version: u64,
    ) -> Result<u64, BlackboardError> {
        
        if let Err(dec) = enforce_topology(&*self.db, session_id, Endpoint::All, Channel::Blackboard) {
            return Err(BlackboardError::RoutingDenied(format!("{:?}", dec)));
        }
        let now = now_secs();
        
        
        let res: rusqlite::Result<Result<u64, BlackboardError>> =
            self.db.with_conn_mut(|conn| {
                let tx = conn.transaction()?;
                let current: Option<i64> = tx
                    .query_row(
                        "SELECT version FROM blackboard WHERE session_id = ?1 AND key = ?2",
                        params![session_id, key],
                        |row| row.get(0),
                    )
                    .optional()?;
                let current_u = current.map(|v| v as u64);
                
                let new_version = match cas_decision(current_u, expected_version) {
                    Ok(v) => v,
                    Err(e) => return Ok(Err(e)),
                };
                match current {
                    None => {
                        tx.execute(
                            "INSERT INTO blackboard (session_id, key, value, version, created_at, updated_at) \
                             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                            params![session_id, key, value, new_version as i64, now, now],
                        )?;
                    }
                    Some(_) => {
                        tx.execute(
                            "UPDATE blackboard SET value = ?3, version = ?4, updated_at = ?5 \
                             WHERE session_id = ?1 AND key = ?2",
                            params![session_id, key, value, new_version as i64, now],
                        )?;
                    }
                }
                tx.commit()?;
                Ok(Ok(new_version))
            });
        res.map_err(|e| BlackboardError::Store(e.to_string()))?
    }
}







fn cas_decision(current: Option<u64>, expected: u64) -> Result<u64, BlackboardError> {
    match (current, expected) {
        (None, 0) => Ok(1),
        (None, _) => Err(BlackboardError::Conflict(0)),
        (Some(v), exp) if v == exp => Ok(v + 1),
        (Some(v), _) => Err(BlackboardError::Conflict(v)),
    }
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::group::topology::{Channel, Endpoint, RouteAction, TopologyEdge, TopologyPolicy};
    use crate::group::topology_repo::TopologyPolicyRepository;
    use crate::storage::connection::DbConnection;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    
    fn tmp_db() -> Arc<DbConnection> {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = PathBuf::from(std::env::temp_dir())
            .join(format!("onedesktop_bb_test_{}_{}", std::process::id(), n));
        Arc::new(DbConnection::open(&dir).expect("open test db"))
    }

    #[test]
    fn cas_decision_pure() {
        
        assert_eq!(cas_decision(None, 0), Ok(1));
        
        assert_eq!(cas_decision(None, 5), Err(BlackboardError::Conflict(0)));
        
        assert_eq!(cas_decision(Some(3), 3), Ok(4));
        
        assert_eq!(cas_decision(Some(3), 99), Err(BlackboardError::Conflict(3)));
    }

    #[test]
    fn blackboard_cas_roundtrip() {
        let db = tmp_db();
        let bb = SqliteBlackboard::new(db);

        
        assert_eq!(bb.read("s1", "k1"), None);

        
        assert_eq!(bb.cas_write("s1", "k1", "v1", 0), Ok(1));
        assert_eq!(bb.read("s1", "k1"), Some(("v1".to_string(), 1)));

        
        assert_eq!(bb.cas_write("s1", "k1", "v2", 1), Ok(2));
        assert_eq!(bb.read("s1", "k1"), Some(("v2".to_string(), 2)));

        
        assert_eq!(
            bb.cas_write("s1", "k1", "vX", 0),
            Err(BlackboardError::Conflict(2))
        );

        
        assert_eq!(
            bb.cas_write("s1", "k1", "vY", 99),
            Err(BlackboardError::Conflict(2))
        );

        
        assert_eq!(bb.cas_write("s1", "k1", "v3", 2), Ok(3));
        assert_eq!(bb.read("s1", "k1"), Some(("v3".to_string(), 3)));

        
        assert_eq!(bb.cas_write("s1", "k2", "a", 0), Ok(1));
        assert_eq!(bb.read("s1", "k2"), Some(("a".to_string(), 1)));

        
        assert_eq!(bb.cas_write("s2", "k1", "b", 0), Ok(1));
        assert_eq!(bb.read("s2", "k1"), Some(("b".to_string(), 1)));

        
        assert_eq!(bb.read("s1", "k1"), Some(("v3".to_string(), 3)));
    }

    #[test]
    fn list_returns_all_entries_sorted_by_key() {
        let db = tmp_db();
        let bb = SqliteBlackboard::new(db);
        
        assert_eq!(bb.cas_write("s1", "zeta", "z", 0), Ok(1));
        assert_eq!(bb.cas_write("s1", "alpha", "a", 0), Ok(1));
        assert_eq!(bb.cas_write("s1", "mid", "m", 0), Ok(1));

        let list = bb.list("s1");
        assert_eq!(list.len(), 3);
        let keys: Vec<&str> = list.iter().map(|(k, _, _)| k.as_str()).collect();
        assert_eq!(keys, vec!["alpha", "mid", "zeta"]);
        
        assert_eq!(list[0], ("alpha".to_string(), "a".to_string(), 1));
        assert_eq!(list[2], ("zeta".to_string(), "z".to_string(), 1));

        
        assert!(bb.list("s2").is_empty());
    }

    #[test]
    fn cas_write_enforces_topology_deny_by_default() {
        let db = tmp_db();
        TopologyPolicyRepository::new(&db)
            .save(
                "g1",
                &TopologyPolicy {
                    version: 1,
                    default: RouteAction::Deny,
                    edges: vec![],
                },
            )
            .unwrap();
        let bb = SqliteBlackboard::new(db);
        
        let r = bb.cas_write("rt:g1:w1", "k1", "v1", 0);
        assert!(matches!(r, Err(BlackboardError::RoutingDenied(_))));
    }

    #[test]
    fn cas_write_allows_on_blackboard_edge() {
        let db = tmp_db();
        let mut p = TopologyPolicy {
            version: 1,
            default: RouteAction::Deny,
            edges: vec![],
        };
        p.edges.push(TopologyEdge {
            from: Endpoint::Worker("w1".into()),
            to: Endpoint::All,
            channels: vec![Channel::Blackboard],
        });
        TopologyPolicyRepository::new(&db).save("g1", &p).unwrap();
        let bb = SqliteBlackboard::new(db);
        
        assert_eq!(bb.cas_write("rt:g1:w1", "k1", "v1", 0), Ok(1));
    }

    #[test]
    fn cas_write_bypasses_non_worker_session() {
        let db = tmp_db();
        
        let bb = SqliteBlackboard::new(db);
        assert_eq!(bb.cas_write("s1", "k1", "v1", 0), Ok(1));
    }
}






use crate::group::topology::TopologyPolicy;
use crate::storage::connection::DbConnection;
use rusqlite::{params, Result as SqliteResult};
use std::time::{SystemTime, UNIX_EPOCH};

pub struct TopologyPolicyRepository<'a> {
    db: &'a DbConnection,
}

impl<'a> TopologyPolicyRepository<'a> {
    pub fn new(db: &'a DbConnection) -> Self {
        Self { db }
    }

    
    pub fn save(&self, group_id: &str, policy: &TopologyPolicy) -> SqliteResult<()> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let json = serde_json::to_string(policy).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                Box::new(e),
            )
        })?;
        self.db.with_conn_mut(|conn| {
            conn.execute(
                "INSERT INTO topology_policies (group_id, version, policy_json, created_at) \
                 VALUES (?1, ?2, ?3, ?4)",
                params![group_id, policy.version as i64, json, now],
            )?;
            Ok(())
        })
    }

    
    pub fn next_version(&self, group_id: &str) -> SqliteResult<u64> {
        self.db.with_conn(|conn| {
            let max: Option<i64> = conn
                .query_row(
                    "SELECT MAX(version) FROM topology_policies WHERE group_id = ?1",
                    params![group_id],
                    |r| r.get(0),
                )
                .ok()
                .flatten();
            Ok(max.map(|v| (v + 1) as u64).unwrap_or(1))
        })
    }

    
    pub fn latest_for_group(&self, group_id: &str) -> SqliteResult<Option<TopologyPolicy>> {
        self.db.with_conn(|conn| {
            let row: Option<String> = conn
                .query_row(
                    "SELECT policy_json FROM topology_policies \
                     WHERE group_id = ?1 ORDER BY version DESC LIMIT 1",
                    params![group_id],
                    |r| r.get(0),
                )
                .ok();
            decode(row)
        })
    }

    
    pub fn find_version(&self, group_id: &str, version: u64) -> SqliteResult<Option<TopologyPolicy>> {
        self.db.with_conn(|conn| {
            let row: Option<String> = conn
                .query_row(
                    "SELECT policy_json FROM topology_policies WHERE group_id = ?1 AND version = ?2",
                    params![group_id, version as i64],
                    |r| r.get(0),
                )
                .ok();
            decode(row)
        })
    }

    
    
    
    
    pub fn commit_next(&self, group_id: &str, mut policy: TopologyPolicy) -> SqliteResult<u64> {
        let v = self.next_version(group_id)?;
        policy.version = v;
        self.save(group_id, &policy)?;
        Ok(v)
    }
}


fn decode(row: Option<String>) -> SqliteResult<Option<TopologyPolicy>> {
    match row {
        Some(json) => serde_json::from_str(&json)
            .map(Some)
            .map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Text,
                    Box::new(e),
                )
            }),
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::group::topology::{Channel, Endpoint, RouteAction, TopologyEdge};
    use crate::storage::connection::DbConnection;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;

    static COUNTER: AtomicU64 = AtomicU64::new(0);
    
    fn tmp_db() -> Arc<DbConnection> {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = PathBuf::from(std::env::temp_dir())
            .join(format!("onedesktop_topo_test_{}_{}", std::process::id(), n));
        Arc::new(DbConnection::open(&dir).expect("open test db"))
    }

    #[test]
    fn save_and_latest_roundtrip() {
        let db = tmp_db();
        let repo = TopologyPolicyRepository::new(&db);
        let policy = TopologyPolicy {
            version: 1,
            default: RouteAction::Deny,
            edges: vec![TopologyEdge {
                from: Endpoint::Worker("a".into()),
                to: Endpoint::Worker("b".into()),
                channels: vec![Channel::Message],
            }],
        };
        repo.save("g1", &policy).unwrap();
        let loaded = repo.latest_for_group("g1").unwrap().unwrap();
        assert_eq!(loaded, policy);
        assert_eq!(repo.next_version("g1").unwrap(), 2);
        assert_eq!(repo.next_version("g2").unwrap(), 1); 
    }

    #[test]
    fn hot_update_keeps_history() {
        let db = tmp_db();
        let repo = TopologyPolicyRepository::new(&db);
        let v1 = TopologyPolicy {
            version: 1,
            default: RouteAction::Deny,
            edges: vec![],
        };
        let v2 = TopologyPolicy {
            version: 2,
            default: RouteAction::Deny,
            edges: vec![TopologyEdge {
                from: Endpoint::All,
                to: Endpoint::All,
                channels: vec![],
            }],
        };
        repo.save("g1", &v1).unwrap();
        repo.save("g1", &v2).unwrap();
        assert_eq!(repo.latest_for_group("g1").unwrap().unwrap().version, 2);
        
        assert_eq!(repo.find_version("g1", 1).unwrap().unwrap().edges.len(), 0);
    }
}

















use crate::agent::ports::{AgentMessage, MessageBus, MessageBusError};
use crate::group::topology::{Channel, Endpoint};
use crate::group::topology_router::{enforce_topology, parse_rt_session};
use crate::storage::connection::DbConnection;
use rusqlite::params;
use std::sync::Arc;


pub struct SqliteMessageBus {
    db: Arc<DbConnection>,
}

impl SqliteMessageBus {
    pub fn new(db: Arc<DbConnection>) -> Self {
        Self { db }
    }
}

impl MessageBus for SqliteMessageBus {
    fn post(&self, msg: AgentMessage) -> Result<(), MessageBusError> {
        
        
        
        if let Some((_, to_w)) = parse_rt_session(&msg.to_session) {
            if let Err(dec) =
                enforce_topology(&*self.db, &msg.from_session, Endpoint::Worker(to_w), Channel::Message)
            {
                return Err(MessageBusError::RoutingDenied(format!("{:?}", dec)));
            }
        }
        self.db
            .with_conn_mut(|conn| {
                conn.execute(
                    "INSERT INTO message_log \
                     (id, from_session, to_session, kind, body_path, delivered, created_at) \
                     VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)",
                    params![
                        msg.id,
                        msg.from_session,
                        msg.to_session,
                        msg.kind,
                        msg.body_path,
                        msg.created_at
                    ],
                )
            })
            .map_err(|e| MessageBusError::Store(e.to_string()))?;
        Ok(())
    }

    fn pending_for(&self, recipient: &str) -> Result<Vec<AgentMessage>, MessageBusError> {
        let rows = self
            .db
            .with_conn(|conn| {
                let mut stmt = conn.prepare(
                    "SELECT id, from_session, to_session, kind, body_path, created_at \
                     FROM message_log \
                     WHERE to_session = ?1 AND delivered = 0 \
                     ORDER BY created_at ASC",
                )?;
                let msgs = stmt
                    .query_map(params![recipient], |row| {
                        Ok(AgentMessage {
                            id: row.get(0)?,
                            from_session: row.get(1)?,
                            to_session: row.get(2)?,
                            kind: row.get(3)?,
                            body_path: row.get(4)?,
                            created_at: row.get(5)?,
                        })
                    })?
                    .collect::<rusqlite::Result<Vec<AgentMessage>>>()?;
                Ok(msgs)
            })
            .map_err(|e| MessageBusError::Store(e.to_string()))?;
        Ok(rows)
    }

    fn mark_delivered(&self, id: &str) -> Result<(), MessageBusError> {
        let n = self
            .db
            .with_conn_mut(|conn| {
                conn.execute(
                    "UPDATE message_log SET delivered = 1 WHERE id = ?1",
                    params![id],
                )
            })
            .map_err(|e| MessageBusError::Store(e.to_string()))?;
        if n == 0 {
            return Err(MessageBusError::NotFound);
        }
        Ok(())
    }
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
            .join(format!("onedesktop_mb_test_{}_{}", std::process::id(), n));
        Arc::new(DbConnection::open(&dir).expect("open test db"))
    }

    #[test]
    fn post_and_pending_roundtrip() {
        let db = tmp_db();
        let bus = SqliteMessageBus::new(db);

        let msg = AgentMessage::new("worker-a", "worker-b", "delegate", "/tmp/task.json");
        let id = msg.id.clone();
        bus.post(msg).expect("post ok");

        
        let pending = bus.pending_for("worker-b").expect("pending ok");
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, id);
        assert_eq!(pending[0].from_session, "worker-a");
        assert_eq!(pending[0].to_session, "worker-b");
        assert_eq!(pending[0].kind, "delegate");
        assert_eq!(pending[0].body_path, "/tmp/task.json");

        
        assert_eq!(bus.pending_for("worker-a").expect("pending ok").len(), 0);

        
        bus.mark_delivered(&id).expect("ack ok");
        assert_eq!(bus.pending_for("worker-b").expect("pending ok").len(), 0);
    }

    #[test]
    fn recipients_are_isolated() {
        let db = tmp_db();
        let bus = SqliteMessageBus::new(db);

        bus.post(AgentMessage::new("a", "b", "x", "/p1")).expect("ok");
        bus.post(AgentMessage::new("a", "c", "x", "/p2")).expect("ok");

        let b = bus.pending_for("b").expect("ok");
        let c = bus.pending_for("c").expect("ok");
        assert_eq!(b.len(), 1);
        assert_eq!(c.len(), 1);
        assert_eq!(b[0].to_session, "b");
        assert_eq!(c[0].to_session, "c");

        
        bus.mark_delivered(&b[0].id).expect("ok");
        assert_eq!(bus.pending_for("b").expect("ok").len(), 0);
        assert_eq!(bus.pending_for("c").expect("ok").len(), 1);
    }

    #[test]
    fn mark_delivered_notfound() {
        let db = tmp_db();
        let bus = SqliteMessageBus::new(db);
        assert_eq!(bus.mark_delivered("ghost"), Err(MessageBusError::NotFound));
    }

    #[test]
    fn pending_returns_fifo_order() {
        let db = tmp_db();
        let bus = SqliteMessageBus::new(db);
        bus.post(AgentMessage::new("a", "b", "m1", "/p1")).expect("ok");
        bus.post(AgentMessage::new("a", "b", "m2", "/p2")).expect("ok");

        let pending = bus.pending_for("b").expect("ok");
        assert_eq!(pending.len(), 2);
        
        assert!(pending[0].created_at <= pending[1].created_at);
        assert_eq!(pending[0].kind, "m1");
        assert_eq!(pending[1].kind, "m2");
    }

    #[test]
    fn post_enforces_topology_deny_by_default() {
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
        let bus = SqliteMessageBus::new(db);
        
        let r = bus.post(AgentMessage::new("rt:g1:w1", "rt:g1:w2", "x", "/p"));
        assert!(matches!(r, Err(MessageBusError::RoutingDenied(_))));
    }

    #[test]
    fn post_allows_on_explicit_edge() {
        let db = tmp_db();
        let mut p = TopologyPolicy {
            version: 1,
            default: RouteAction::Deny,
            edges: vec![],
        };
        p.edges.push(TopologyEdge {
            from: Endpoint::Worker("w1".into()),
            to: Endpoint::Worker("w2".into()),
            channels: vec![Channel::Message],
        });
        TopologyPolicyRepository::new(&db).save("g1", &p).unwrap();
        let bus = SqliteMessageBus::new(db);
        
        assert!(bus.post(AgentMessage::new("rt:g1:w1", "rt:g1:w2", "x", "/p")).is_ok());
        
        assert!(matches!(
            bus.post(AgentMessage::new("rt:g1:w2", "rt:g1:w1", "x", "/p")),
            Err(MessageBusError::RoutingDenied(_))
        ));
    }

    #[test]
    fn post_bypasses_non_worker_recipient() {
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
        let bus = SqliteMessageBus::new(db);
        assert!(bus.post(AgentMessage::new("rt:g1:w1", "main-session", "x", "/p")).is_ok());
    }
}

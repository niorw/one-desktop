








use crate::group::topology::{
    evaluate_topology, Channel, Endpoint, RouteAction, RouteDecision, RouteReason,
};
use crate::group::topology_repo::TopologyPolicyRepository;
use crate::group::worker_repo::WorkerRepository;
use crate::storage::connection::DbConnection;
use crate::storage::repository::Repository;


pub fn parse_rt_session(session: &str) -> Option<(String, String)> {
    let rest = session.strip_prefix("rt:")?;
    let (g, w) = rest.split_once(':')?;
    if g.is_empty() || w.is_empty() {
        return None;
    }
    Some((g.to_string(), w.to_string()))
}









pub fn enforce_topology(
    db: &DbConnection,
    from_session: &str,
    to: Endpoint,
    channel: Channel,
) -> Result<(), RouteDecision> {
    
    let (group_id, from_w) = match parse_rt_session(from_session) {
        Some(x) => x,
        None => return Ok(()),
    };
    let repo = TopologyPolicyRepository::new(db);
    let policy = match repo.latest_for_group(&group_id) {
        Ok(Some(p)) => p,
        
        _ => {
            return Err(RouteDecision {
                action: RouteAction::Deny,
                reason: RouteReason::DefaultDeny,
            })
        }
    };
    let to_str = match &to {
        Endpoint::All => "",
        Endpoint::Worker(w) => w,
    };
    let decision = evaluate_topology(&policy, &from_w, to_str, channel);
    if decision.action == RouteAction::Deny {
        Err(decision)
    } else {
        Ok(())
    }
}












pub fn enforce_mention(
    db: &DbConnection,
    group_id: &str,
    target_worker: &str,
) -> Result<(), RouteDecision> {
    
    
    if let Ok(Some(w)) = WorkerRepository::new(db).find_by_id(target_worker) {
        if w.group_id == group_id {
            return Ok(());
        }
    }
    let repo = TopologyPolicyRepository::new(db);
    let policy = match repo.latest_for_group(group_id) {
        Ok(Some(p)) => p,
        
        _ => {
            return Err(RouteDecision {
                action: RouteAction::Deny,
                reason: RouteReason::DefaultDeny,
            })
        }
    };
    let decision = evaluate_topology(&policy, GROUP_SOURCE, target_worker, Channel::Mention);
    if decision.action == RouteAction::Deny {
        Err(decision)
    } else {
        Ok(())
    }
}



const GROUP_SOURCE: &str = "";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::group::topology::{RouteAction, TopologyEdge, TopologyPolicy};
    use crate::group::worker::CreateWorkerPayload;
    use crate::group::SeatType;
    use crate::group::worker_repo::WorkerRepository;
    use crate::storage::connection::DbConnection;
    use crate::storage::repository::Repository;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;

    static COUNTER: AtomicU64 = AtomicU64::new(0);
    
    fn tmp_db() -> Arc<DbConnection> {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = PathBuf::from(std::env::temp_dir())
            .join(format!("onedesktop_rt_test_{}_{}", std::process::id(), n));
        Arc::new(DbConnection::open(&dir).expect("open test db"))
    }

    
    fn deny_all(db: &DbConnection, g: &str) {
        TopologyPolicyRepository::new(db)
            .save(
                g,
                &TopologyPolicy {
                    version: 1,
                    default: RouteAction::Deny,
                    edges: vec![],
                },
            )
            .unwrap();
    }

    #[test]
    fn non_worker_sender_bypasses() {
        let db = tmp_db();
        
        deny_all(&db, "g1");
        assert!(enforce_topology(&db, "main-session", Endpoint::Worker("w2".into()), Channel::Message).is_ok());
    }

    #[test]
    fn worker_to_worker_denied_by_default() {
        let db = tmp_db();
        deny_all(&db, "g1");
        let d = enforce_topology(&db, "rt:g1:w1", Endpoint::Worker("w2".into()), Channel::Message);
        assert!(d.is_err());
    }

    #[test]
    fn worker_to_worker_allowed_on_edge() {
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
        assert!(enforce_topology(&db, "rt:g1:w1", Endpoint::Worker("w2".into()), Channel::Message).is_ok());
        
        assert!(enforce_topology(&db, "rt:g1:w2", Endpoint::Worker("w1".into()), Channel::Message).is_err());
    }

    #[test]
    fn blackboard_channel_scoped() {
        let db = tmp_db();
        let mut p = TopologyPolicy {
            version: 1,
            default: RouteAction::Deny,
            edges: vec![],
        };
        p.edges.push(TopologyEdge {
            from: Endpoint::Worker("w1".into()),
            to: Endpoint::All,
            channels: vec![Channel::Message], 
        });
        TopologyPolicyRepository::new(&db).save("g1", &p).unwrap();
        
        assert!(enforce_topology(&db, "rt:g1:w1", Endpoint::All, Channel::Blackboard).is_err());
        
        assert!(enforce_topology(&db, "rt:g1:w1", Endpoint::Worker("w2".into()), Channel::Message).is_ok());
    }

    #[test]
    fn self_target_allowed_under_deny_all() {
        let db = tmp_db();
        deny_all(&db, "g1");
        assert!(enforce_topology(&db, "rt:g1:w1", Endpoint::Worker("w1".into()), Channel::Blackboard).is_ok());
    }

    #[test]
    fn missing_policy_is_fail_closed() {
        let db = tmp_db(); 
        assert!(enforce_topology(&db, "rt:g1:w1", Endpoint::Worker("w2".into()), Channel::Message).is_err());
    }

    

    #[test]
    fn mention_denied_by_default() {
        let db = tmp_db();
        deny_all(&db, "g1");
        
        assert!(enforce_mention(&db, "g1", "w2").is_err());
    }

    #[test]
    fn mention_allowed_for_group_member_even_if_deny_all() {
        let db = tmp_db();
        deny_all(&db, "g1");
        
        let w = WorkerRepository::new(&db)
            .create(CreateWorkerPayload {
                group_id: "g1".into(),
                agent_ref: "ag_writer".into(),
                seat_type: SeatType::Static,
                capabilities: vec!["write".into()],
                max_concurrency: 1,
            })
            .unwrap();
        
        assert!(enforce_mention(&db, "g1", &w.id).is_ok());
        
        assert!(enforce_mention(&db, "g1", "not_a_member").is_err());
        
        deny_all(&db, "g2");
        assert!(enforce_mention(&db, "g2", &w.id).is_err());
    }

    #[test]
    fn mention_allowed_via_all_edge() {
        let db = tmp_db();
        let mut p = TopologyPolicy {
            version: 1,
            default: RouteAction::Deny,
            edges: vec![],
        };
        p.edges.push(TopologyEdge {
            from: Endpoint::All,
            to: Endpoint::All,
            channels: vec![Channel::Mention], 
        });
        TopologyPolicyRepository::new(&db).save("g1", &p).unwrap();
        assert!(enforce_mention(&db, "g1", "w7").is_ok());
        
        assert!(enforce_topology(&db, "rt:g1:w1", Endpoint::Worker("w7".into()), Channel::Message).is_err());
    }

    #[test]
    fn mention_specific_worker_scoped() {
        let db = tmp_db();
        let mut p = TopologyPolicy {
            version: 1,
            default: RouteAction::Deny,
            edges: vec![],
        };
        p.edges.push(TopologyEdge {
            from: Endpoint::All,
            to: Endpoint::Worker("w2".into()),
            channels: vec![Channel::Mention],
        });
        TopologyPolicyRepository::new(&db).save("g1", &p).unwrap();
        assert!(enforce_mention(&db, "g1", "w2").is_ok()); 
        assert!(enforce_mention(&db, "g1", "w3").is_err()); 
    }
}

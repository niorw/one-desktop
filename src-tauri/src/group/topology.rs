








use serde::{Deserialize, Serialize};


#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Channel {
    
    Message,
    
    Blackboard,
    
    Mention,
}


#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum RouteAction {
    Allow,
    #[default]
    Deny,
}


#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Endpoint {
    
    All,
    
    Worker(String),
}

impl Endpoint {
    fn matches(&self, worker_id: &str) -> bool {
        match self {
            Endpoint::All => true,
            Endpoint::Worker(w) => w == worker_id,
        }
    }
}



#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TopologyEdge {
    pub from: Endpoint,
    pub to: Endpoint,
    #[serde(default)]
    pub channels: Vec<Channel>,
}


#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TopologyPolicy {
    
    pub version: u64,
    
    #[serde(default)]
    pub default: RouteAction,
    
    #[serde(default)]
    pub edges: Vec<TopologyEdge>,
}

impl Default for TopologyPolicy {
    fn default() -> Self {
        Self {
            version: 1,
            default: RouteAction::Deny,
            edges: Vec::new(),
        }
    }
}


#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouteDecision {
    pub action: RouteAction,
    
    pub reason: RouteReason,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RouteReason {
    
    SelfTarget,
    
    AllowedByEdge(usize),
    
    DefaultDeny,
}











pub fn evaluate_topology(
    policy: &TopologyPolicy,
    from: &str,
    to: &str,
    channel: Channel,
) -> RouteDecision {
    if from == to {
        return RouteDecision {
            action: RouteAction::Allow,
            reason: RouteReason::SelfTarget,
        };
    }
    for (i, edge) in policy.edges.iter().enumerate() {
        let channel_ok = edge.channels.is_empty() || edge.channels.contains(&channel);
        if channel_ok && edge.from.matches(from) && edge.to.matches(to) {
            return RouteDecision {
                action: RouteAction::Allow,
                reason: RouteReason::AllowedByEdge(i),
            };
        }
    }
    RouteDecision {
        action: policy.default,
        reason: RouteReason::DefaultDeny,
    }
}






pub fn worker_id_from_session(session: &str, group_id: &str) -> Option<String> {
    let prefix = format!("rt:{}:", group_id);
    session.strip_prefix(&prefix).map(|w| w.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn deny_policy() -> TopologyPolicy {
        TopologyPolicy {
            version: 1,
            default: RouteAction::Deny,
            edges: vec![],
        }
    }

    #[test]
    fn default_deny_blocks_unauthorized() {
        let d = evaluate_topology(&deny_policy(), "w1", "w2", Channel::Message);
        assert_eq!(d.action, RouteAction::Deny);
        assert_eq!(d.reason, RouteReason::DefaultDeny);
    }

    #[test]
    fn explicit_allow_edge_wins() {
        let p = TopologyPolicy {
            version: 1,
            default: RouteAction::Deny,
            edges: vec![TopologyEdge {
                from: Endpoint::Worker("w1".into()),
                to: Endpoint::Worker("w2".into()),
                channels: vec![Channel::Message],
            }],
        };
        let d = evaluate_topology(&p, "w1", "w2", Channel::Message);
        assert_eq!(d.action, RouteAction::Allow);
        assert_eq!(d.reason, RouteReason::AllowedByEdge(0));
        
        assert_eq!(
            evaluate_topology(&p, "w2", "w1", Channel::Message).action,
            RouteAction::Deny
        );
    }

    #[test]
    fn channel_scoping_is_enforced() {
        let p = TopologyPolicy {
            version: 1,
            default: RouteAction::Deny,
            edges: vec![TopologyEdge {
                from: Endpoint::Worker("w1".into()),
                to: Endpoint::Worker("w2".into()),
                channels: vec![Channel::Message],
            }],
        };
        
        assert_eq!(
            evaluate_topology(&p, "w1", "w2", Channel::Blackboard).action,
            RouteAction::Deny
        );
        
        let p_all = TopologyPolicy {
            version: 1,
            default: RouteAction::Deny,
            edges: vec![TopologyEdge {
                from: Endpoint::Worker("w1".into()),
                to: Endpoint::Worker("w2".into()),
                channels: vec![],
            }],
        };
        assert_eq!(
            evaluate_topology(&p_all, "w1", "w2", Channel::Blackboard).action,
            RouteAction::Allow
        );
    }

    #[test]
    fn wildcard_allows_any() {
        let p = TopologyPolicy {
            version: 1,
            default: RouteAction::Deny,
            edges: vec![TopologyEdge {
                from: Endpoint::All,
                to: Endpoint::All,
                channels: vec![],
            }],
        };
        assert_eq!(
            evaluate_topology(&p, "wX", "wY", Channel::Message).action,
            RouteAction::Allow
        );
        assert_eq!(
            evaluate_topology(&p, "wX", "wY", Channel::Blackboard).action,
            RouteAction::Allow
        );
    }

    #[test]
    fn self_target_always_allowed() {
        let d = evaluate_topology(&deny_policy(), "w1", "w1", Channel::Blackboard);
        assert_eq!(d.action, RouteAction::Allow);
        assert_eq!(d.reason, RouteReason::SelfTarget);
    }

    #[test]
    fn session_to_worker_id_translation() {
        assert_eq!(worker_id_from_session("rt:g1:w3", "g1"), Some("w3".into()));
        assert_eq!(worker_id_from_session("rt:g2:w3", "g1"), None); 
        assert_eq!(worker_id_from_session("main-session", "g1"), None); 
    }
}

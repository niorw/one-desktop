






use crate::group::topology::TopologyPolicy;
use serde::{Deserialize, Serialize};





#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GroupManifest {
    pub name: String,
    pub goal: String,
    
    #[serde(default)]
    pub owner_agent_ref: Option<String>,
    
    #[serde(default)]
    pub seats: Vec<SeatSpec>,
    
    #[serde(default)]
    pub topology: TopologyPolicy,
}



#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SeatSpec {
    
    pub agent_ref: String,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub max_instances: Option<u32>,
}


#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManifestError {
    
    InvalidJson(String),
}

impl std::fmt::Display for ManifestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ManifestError::InvalidJson(e) => write!(f, "invalid manifest json: {}", e),
        }
    }
}

impl GroupManifest {
    
    pub fn from_json(s: &str) -> Result<Self, ManifestError> {
        serde_json::from_str(s).map_err(|e| ManifestError::InvalidJson(e.to_string()))
    }

    
    
    pub fn to_seat_config(&self) -> serde_json::Value {
        let refs: Vec<&str> = self.seats.iter().map(|s| s.agent_ref.as_str()).collect();
        serde_json::json!({ "static": refs })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::group::topology::{Channel, Endpoint, RouteAction, TopologyEdge};

    #[test]
    fn parse_full_manifest_with_topology() {
        let json = r#"{
            "name": "研究群",
            "goal": "对比两份报告",
            "owner_agent_ref": "ag_owner",
            "seats": [{"agent_ref": "ag_w1", "role": "研究员"}, {"agent_ref": "ag_w2"}],
            "topology": {
                "version": 1,
                "default": "Deny",
                "edges": [{"from": "All", "to": {"Worker": "w1"}, "channels": ["Message", "Mention"]}]
            }
        }"#;
        let m = GroupManifest::from_json(json).unwrap();
        assert_eq!(m.name, "研究群");
        assert_eq!(m.owner_agent_ref.as_deref(), Some("ag_owner"));
        assert_eq!(m.seats.len(), 2);
        assert_eq!(m.seats[0].agent_ref, "ag_w1");
        assert_eq!(m.seats[0].role.as_deref(), Some("研究员"));
        assert_eq!(m.seats[1].max_instances, None);
        
        assert_eq!(m.topology.default, RouteAction::Deny);
        assert_eq!(
            m.topology.edges,
            vec![TopologyEdge {
                from: Endpoint::All,
                to: Endpoint::Worker("w1".into()),
                channels: vec![Channel::Message, Channel::Mention],
            }]
        );
        
        assert_eq!(
            m.to_seat_config(),
            serde_json::json!({ "static": ["ag_w1", "ag_w2"] })
        );
    }

    #[test]
    fn parse_minimal_manifest_defaults_to_deny_all() {
        
        let json = r#"{"name": "空群", "goal": "随便"}"#;
        let m = GroupManifest::from_json(json).unwrap();
        assert_eq!(m.owner_agent_ref, None);
        assert!(m.seats.is_empty());
        
        assert_eq!(m.topology, TopologyPolicy::default());
        assert_eq!(m.to_seat_config(), serde_json::json!({ "static": [] }));
    }

    #[test]
    fn reject_invalid_json() {
        assert!(matches!(
            GroupManifest::from_json("{ not json"),
            Err(ManifestError::InvalidJson(_))
        ));
    }

    #[test]
    fn reject_missing_required_field() {
        
        let json = r#"{"name": "缺字段"}"#;
        assert!(matches!(
            GroupManifest::from_json(json),
            Err(ManifestError::InvalidJson(_))
        ));
    }
}

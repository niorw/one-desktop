






use serde::{Deserialize, Serialize};


#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct A2aCapabilities {
    
    pub streaming: bool,
    
    pub push_notifications: bool,
    
    pub state_transition_history: bool,
}


#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct A2aAgentCard {
    
    pub schema: String,
    pub name: String,
    pub description: String,
    
    pub url: String,
    
    pub preferred_transport: String,
    pub capabilities: A2aCapabilities,
}

impl A2aAgentCard {
    
    pub fn local() -> Self {
        Self {
            schema: "https://schema.a2a-protocol.org/v0.2/agent-card.json".into(),
            name: "OneDesktop Roundtable".into(),
            description: "群协作圆桌：群主派活 / 圆桌讨论 / 广播竞速的本地多 Agent 协作端点（A2A 进程内绑定）。".into(),
            url: "onedesktop://a2a/roundtable".into(),
            preferred_transport: "in-process".into(),
            capabilities: A2aCapabilities {
                streaming: false,
                push_notifications: false,
                state_transition_history: true,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_card_is_serializable_and_faithful() {
        let card = A2aAgentCard::local();
        let json = serde_json::to_string(&card).unwrap();
        
        let back: A2aAgentCard = serde_json::from_str(&json).unwrap();
        assert_eq!(back.name, "OneDesktop Roundtable");
        assert_eq!(back.preferred_transport, "in-process");
        assert!(back.capabilities.state_transition_history);
        assert!(!back.capabilities.streaming);
        assert!(!back.capabilities.push_notifications);
    }
}

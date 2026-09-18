





use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;


#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum A2aTaskState {
    Submitted,
    Working,
    Completed,
    Failed,
    Canceled,
    
    InputRequired,
    
    Rejected,
    
    AuthRequired,
    Unspecified,
}


#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct A2aPart {
    #[serde(rename = "type")]
    pub part_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uri: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub metadata: BTreeMap<String, serde_json::Value>,
}

impl A2aPart {
    pub fn text(content: &str) -> Self {
        Self {
            part_type: "text".into(),
            text: Some(content.to_string()),
            uri: None,
            data: None,
            metadata: BTreeMap::new(),
        }
    }
}


#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct A2aMessage {
    pub message_id: String,
    pub context_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    pub role: String,
    pub parts: Vec<A2aPart>,
    
    #[serde(default)]
    pub reference_task_ids: Vec<String>,
}


#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct A2aArtifact {
    pub artifact_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub parts: Vec<A2aPart>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub metadata: BTreeMap<String, serde_json::Value>,
}




#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct A2aTask {
    pub task_id: String,
    pub context_id: String,
    pub status: A2aTaskState,
    #[serde(default)]
    pub messages: Vec<A2aMessage>,
    #[serde(default)]
    pub artifacts: Vec<A2aArtifact>,
    #[serde(default)]
    pub metadata: BTreeMap<String, serde_json::Value>,
}

impl A2aTask {
    
    pub fn task_card_text(&self) -> String {
        self.messages
            .iter()
            .rev()
            .find(|m| m.role == "user")
            .and_then(|m| m.parts.first())
            .and_then(|p| p.text.clone())
            .unwrap_or_default()
    }

    
    pub fn meta_str(&self, key: &str, default: &str) -> String {
        self.metadata
            .get(key)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| default.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_task() -> A2aTask {
        let msg = A2aMessage {
            message_id: "m1".into(),
            context_id: "g:w".into(),
            task_id: Some("t1".into()),
            role: "user".into(),
            parts: vec![A2aPart::text("调研竞品定价")],
            reference_task_ids: vec!["t0".into()],
        };
        let mut meta = BTreeMap::new();
        meta.insert("model".into(), serde_json::json!("deepseek-chat"));
        A2aTask {
            task_id: "t1".into(),
            context_id: "g:w".into(),
            status: A2aTaskState::Submitted,
            messages: vec![msg],
            artifacts: vec![],
            metadata: meta,
        }
    }

    #[test]
    fn task_card_text_extracts_last_user_part() {
        let t = sample_task();
        assert_eq!(t.task_card_text(), "调研竞品定价");
    }

    #[test]
    fn meta_str_falls_back() {
        let t = sample_task();
        assert_eq!(t.meta_str("model", "x"), "deepseek-chat");
        assert_eq!(t.meta_str("provider", "deepseek"), "deepseek");
    }

    #[test]
    fn state_machine_has_nine_states() {
        let all = vec![
            A2aTaskState::Submitted,
            A2aTaskState::Working,
            A2aTaskState::Completed,
            A2aTaskState::Failed,
            A2aTaskState::Canceled,
            A2aTaskState::InputRequired,
            A2aTaskState::Rejected,
            A2aTaskState::AuthRequired,
            A2aTaskState::Unspecified,
        ];
        assert_eq!(all.len(), 9);
    }
}

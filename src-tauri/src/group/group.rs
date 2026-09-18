




use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum GroupStatus {
    Draft,
    Active,
    Paused,
    Archiving,
    Archived,
}








#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum GroupKind {
    #[default]
    Chat,
    Research,
    Dev,
}


#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum SeatType {
    Static,
    Dynamic,
    Capability,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Group {
    pub id: String,
    pub name: String,
    pub goal: String,
    pub owner_agent_ref: String,
    pub status: GroupStatus,
    
    pub kind: GroupKind,
    
    pub seat_config: serde_json::Value,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateGroupPayload {
    pub name: String,
    pub goal: String,
    pub owner_agent_ref: String,
    pub seat_config: serde_json::Value,
    
    #[serde(default)]
    pub kind: GroupKind,
}







#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupListItem {
    pub id: String,
    pub name: String,
    pub goal: String,
    pub owner_agent_ref: String,
    pub status: GroupStatus,
    pub kind: GroupKind,
    pub seat_config: serde_json::Value,
    pub created_at: i64,
    
    pub updated_at: Option<i64>,
    
    pub member_count: i64,
    
    pub last_message_preview: Option<String>,
}

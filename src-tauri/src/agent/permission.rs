












use serde::{Deserialize, Serialize};






#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RiskClass {
    Safe,
    Mediated,
    Dangerous,
}



pub fn risk_class(tool: &str) -> RiskClass {
    if tool.starts_with("mcp__") || tool.starts_with("skill__") {
        return RiskClass::Mediated;
    }
    match tool {
        "read_file" | "write_file" | "list_dir" | "get_weather" | "assign_tasks" => RiskClass::Safe,
        
        
        
        "read_state" | "update_state" => RiskClass::Safe,
        
        
        "kanban_task_create" | "kanban_task_list" | "kanban_task_update" | "kanban_task_delete" => {
            RiskClass::Safe
        }
        "run_shell" | "update_memory" => RiskClass::Dangerous,
        
        _ => RiskClass::Mediated,
    }
}


pub const SAFE_TOOLS: &[&str] = &[
    "read_file",
    "write_file",
    "list_dir",
    "get_weather",
    "assign_tasks",
    "read_state",
    "update_state",
];

pub const DANGEROUS_TOOLS: &[&str] = &["run_shell", "update_memory"];



#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionKind {
    
    User,
    
    AttendedWorker,
    
    UnattendedWorker,
}

impl SessionKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            SessionKind::User => "user",
            SessionKind::AttendedWorker => "attended_worker",
            SessionKind::UnattendedWorker => "unattended_worker",
        }
    }
}


#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Permission {
    Allow,
    Deny,
    Ask,
}

impl std::fmt::Display for Permission {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Permission::Allow => write!(f, "allow"),
            Permission::Deny => write!(f, "deny"),
            Permission::Ask => write!(f, "ask"),
        }
    }
}


#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolPermission {
    pub tool_name: String,
    pub scope: String,
    pub action: Permission,
}



pub fn decide(
    tool_name: &str,
    kind: SessionKind,
    global_auto_approve: bool,
    overrides: &[ToolPermission],
) -> Permission {
    
    
    let exact = overrides.iter().find(|o| {
        o.tool_name == tool_name
            && (o.scope == kind.as_str() || (kind != SessionKind::User && o.scope == "worker"))
    });
    if let Some(o) = exact {
        return o.action;
    }
    let wildcard = overrides
        .iter()
        .find(|o| o.tool_name == tool_name && o.scope == "all");
    if let Some(o) = wildcard {
        return o.action;
    }

    
    if kind == SessionKind::User && global_auto_approve {
        return Permission::Allow;
    }

    
    match kind {
        SessionKind::User => Permission::Ask,
        SessionKind::AttendedWorker | SessionKind::UnattendedWorker => match risk_class(tool_name) {
            RiskClass::Safe => Permission::Allow,
            RiskClass::Mediated => {
                
                
                if kind == SessionKind::AttendedWorker {
                    Permission::Ask
                } else {
                    Permission::Deny
                }
            }
            RiskClass::Dangerous => Permission::Deny,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn perm(tool: &str, scope: &str, action: Permission) -> ToolPermission {
        ToolPermission {
            tool_name: tool.into(),
            scope: scope.into(),
            action,
        }
    }

    #[test]
    fn user_session_defaults_to_ask() {
        assert_eq!(
            decide("run_shell", SessionKind::User, false, &[]),
            Permission::Ask
        );
        assert_eq!(
            decide("read_file", SessionKind::User, false, &[]),
            Permission::Ask
        );
    }

    #[test]
    fn user_global_auto_approve_allows_all() {
        assert_eq!(
            decide("run_shell", SessionKind::User, true, &[]),
            Permission::Allow
        );
        assert_eq!(
            decide("anything", SessionKind::User, true, &[]),
            Permission::Allow
        );
    }

    #[test]
    fn attended_worker_risk_matrix() {
        
        assert_eq!(
            decide("read_file", SessionKind::AttendedWorker, false, &[]),
            Permission::Allow
        );
        assert_eq!(
            decide("write_file", SessionKind::AttendedWorker, false, &[]),
            Permission::Allow
        );
        assert_eq!(
            decide("list_dir", SessionKind::AttendedWorker, false, &[]),
            Permission::Allow
        );
        assert_eq!(
            decide("get_weather", SessionKind::AttendedWorker, false, &[]),
            Permission::Allow
        );
        
        
        assert_eq!(
            decide("read_state", SessionKind::AttendedWorker, false, &[]),
            Permission::Allow
        );
        assert_eq!(
            decide("update_state", SessionKind::AttendedWorker, false, &[]),
            Permission::Allow
        );
        
        assert_eq!(
            decide("mcp__github__create_issue", SessionKind::AttendedWorker, false, &[]),
            Permission::Ask
        );
        
        assert_eq!(
            decide("run_shell", SessionKind::AttendedWorker, false, &[]),
            Permission::Deny
        );
        assert_eq!(
            decide("update_memory", SessionKind::AttendedWorker, false, &[]),
            Permission::Deny
        );
    }

    #[test]
    fn unattended_worker_mediated_denied() {
        
        assert_eq!(
            decide("read_file", SessionKind::UnattendedWorker, false, &[]),
            Permission::Allow
        );
        
        assert_eq!(
            decide("mcp__github__create_issue", SessionKind::UnattendedWorker, false, &[]),
            Permission::Deny
        );
        
        assert_eq!(
            decide("run_shell", SessionKind::UnattendedWorker, false, &[]),
            Permission::Deny
        );
        
        assert_eq!(
            decide("some_new_tool", SessionKind::UnattendedWorker, false, &[]),
            Permission::Deny
        );
    }

    #[test]
    fn explicit_override_wins() {
        
        let overrides = vec![perm("run_shell", "worker", Permission::Allow)];
        assert_eq!(
            decide("run_shell", SessionKind::AttendedWorker, false, &overrides),
            Permission::Allow
        );
        assert_eq!(
            decide("run_shell", SessionKind::UnattendedWorker, false, &overrides),
            Permission::Allow
        );
        
        let overrides = vec![perm("update_memory", "all", Permission::Ask)];
        assert_eq!(
            decide("update_memory", SessionKind::User, false, &overrides),
            Permission::Ask
        );
        
        let overrides = vec![
            perm("run_shell", "all", Permission::Ask),
            perm("run_shell", "attended_worker", Permission::Deny),
        ];
        assert_eq!(
            decide("run_shell", SessionKind::AttendedWorker, false, &overrides),
            Permission::Deny
        );
        
        assert_eq!(
            decide("read_file", SessionKind::AttendedWorker, false, &overrides),
            Permission::Allow
        );
    }

    #[test]
    fn risk_class_classifies() {
        assert_eq!(risk_class("read_file"), RiskClass::Safe);
        assert_eq!(risk_class("mcp__srv__tool"), RiskClass::Mediated);
        assert_eq!(risk_class("skill__x__y"), RiskClass::Mediated);
        assert_eq!(risk_class("run_shell"), RiskClass::Dangerous);
        assert_eq!(risk_class("unknown_tool"), RiskClass::Mediated);
    }
}

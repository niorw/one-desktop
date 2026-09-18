





use serde::{Deserialize, Serialize};
use std::collections::HashSet;


















#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DiagnosticClass {
    MissingGrant,
    RevokedCredential,
    OrphanedGrant,
    UnavailableProvider,
    CliExecutorMissing,
    CliExecutorLaunchFailed,
    CliExecutorAuthMissing,
}


#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapabilityDiagnostic {
    pub class: DiagnosticClass,
    
    pub scope: String,
    pub title: String,
    pub detail: String,
    pub fix_hint: String,
}


#[derive(Debug, Clone)]
pub struct McpServerHealth {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub healthy: bool,
    pub error: Option<String>,
}



#[derive(Debug, Clone)]
pub struct AgentSkillRef {
    
    pub agent_name: String,
    
    pub skill_id: String,
}






#[derive(Debug, Clone, Default)]
pub struct CliExecutorHealth {
    
    pub id: String,
    
    pub binary: String,
    
    pub state: CliExecutorState,
}



#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CliExecutorState {
    #[default]
    Available,
    NotFound,
    LaunchFailed,
    AuthMissing,
}


#[derive(Debug, Clone, Default)]
pub struct DiagnosticInput {
    pub mcp_servers: Vec<McpServerHealth>,
    pub skill_ids: Vec<String>,
    pub budgeted_skill_ids: Vec<String>,
    pub cli_executors: Vec<CliExecutorHealth>,
    
    pub agent_skill_refs: Vec<AgentSkillRef>,
}


pub fn evaluate(input: &DiagnosticInput) -> Vec<CapabilityDiagnostic> {
    let mut out = Vec::new();

    
    
    
    for s in &input.mcp_servers {
        if !s.enabled || s.healthy {
            continue;
        }
        let err = s.error.clone().unwrap_or_default();
        let (class, title, detail, fix_hint) = if is_auth_featured(&err) {
            (
                DiagnosticClass::RevokedCredential,
                format!("MCP 服务「{}」凭证已失效或无权访问", s.name),
                if err.is_empty() {
                    "健康检查失败，且失败特征指向鉴权（401/403/unauthorized/api key）".to_string()
                } else {
                    err
                },
                "在设置中更新该服务的 API Key / 凭证，或检查访问权限配置".to_string(),
            )
        } else {
            (
                DiagnosticClass::UnavailableProvider,
                format!("MCP 服务「{}」运行期不可用", s.name),
                if err.is_empty() {
                    "健康检查未通过".to_string()
                } else {
                    err
                },
                "检查该服务的启动命令/URL 与凭证，或在设置中重新连接".to_string(),
            )
        };
        out.push(CapabilityDiagnostic {
            class,
            scope: format!("mcp:{}", s.name),
            title,
            detail,
            fix_hint,
        });
    }

    
    let skill_set: HashSet<&str> = input.skill_ids.iter().map(|s| s.as_str()).collect();
    for bid in &input.budgeted_skill_ids {
        if !skill_set.contains(bid.as_str()) {
            out.push(CapabilityDiagnostic {
                class: DiagnosticClass::OrphanedGrant,
                scope: format!("skill:{}", bid),
                title: format!("技能「{}」的预算指向已不存在的技能", bid),
                detail: "skill_budgets 中存在该技能 id 的预算配置，但 skills 表已无此技能".to_string(),
                fix_hint: "在技能预算设置中删除该孤立配置，或重新导入对应技能".to_string(),
            });
        }
    }

    
    
    for r in &input.agent_skill_refs {
        if r.skill_id.is_empty() {
            continue;
        }
        if !skill_set.contains(r.skill_id.as_str()) {
            out.push(CapabilityDiagnostic {
                class: DiagnosticClass::MissingGrant,
                scope: format!("agent:{}", r.agent_name),
                title: format!("Agent「{}」引用了不存在的技能「{}」", r.agent_name, r.skill_id),
                detail: format!(
                    "agents 表声明的 skills 含「{}」，但 skills 表已无此技能 → Agent 能力缺口",
                    r.skill_id
                ),
                fix_hint: "重新导入该技能，或从该 Agent 预设的 skills 配置中移除引用".to_string(),
            });
        }
    }

    
    
    
    for c in &input.cli_executors {
        let (class, title, detail, fix_hint) = match c.state {
            CliExecutorState::Available => continue,
            CliExecutorState::NotFound => (
                DiagnosticClass::CliExecutorMissing,
                format!("外部 CLI 执行器「{}」本机未安装", c.binary),
                format!(
                    "本机 PATH 中未检测到 {} 可执行文件；配置了该执行器的 seat 派发将直接失败",
                    c.binary
                ),
                format!(
                    "安装 {} 并确保其在 PATH 中（如 `brew install {}`），或在 seat 设置中把执行器切回内部引擎",
                    c.binary, c.binary
                ),
            ),
            CliExecutorState::LaunchFailed => (
                DiagnosticClass::CliExecutorLaunchFailed,
                format!("外部 CLI 执行器「{}」启动失败", c.binary),
                format!(
                    "{} 已安装但 `--version` 退出非零或其他 spawn 错误；可能损坏或版本不兼容",
                    c.binary
                ),
                format!(
                    "重装/升级 {} 或检查其运行依赖，或在 seat 设置中把执行器切回内部引擎",
                    c.binary
                ),
            ),
            CliExecutorState::AuthMissing => (
                DiagnosticClass::CliExecutorAuthMissing,
                format!("外部 CLI 执行器「{}」未登录或凭证缺失", c.binary),
                format!(
                    "{} 已安装且可启动，但鉴权探针未通过（未登录 / API Key 缺失或失效）；配置了该执行器的 seat 派发将因鉴权失败",
                    c.binary
                ),
                format!(
                    "运行 `{} login`（或按官方文档配置 API Key / 登录凭证），完成后重新体检",
                    c.binary
                ),
            ),
        };
        out.push(CapabilityDiagnostic {
            class,
            scope: format!("cli:{}", c.id),
            title,
            detail,
            fix_hint,
        });
    }

    out
}


fn is_auth_featured(text: &str) -> bool {
    let t = text.to_lowercase();
    ["401", "403", "unauthorized", "authentication", "api key", "api_key", "invalid key", "auth", "credential", "token expired", "access denied"]
        .iter()
        .any(|k| t.contains(k))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input_with(
        servers: Vec<McpServerHealth>,
        skills: Vec<&str>,
        budgeted: Vec<&str>,
    ) -> DiagnosticInput {
        DiagnosticInput {
            mcp_servers: servers,
            skill_ids: skills.into_iter().map(|s| s.to_string()).collect(),
            budgeted_skill_ids: budgeted.into_iter().map(|s| s.to_string()).collect(),
            cli_executors: vec![],
            agent_skill_refs: vec![],
        }
    }

    #[test]
    fn healthy_enabled_server_not_flagged() {
        let inp = input_with(
            vec![McpServerHealth {
                id: "1".into(),
                name: "srv".into(),
                enabled: true,
                healthy: true,
                error: None,
            }],
            vec![],
            vec![],
        );
        assert!(evaluate(&inp).is_empty());
    }

    #[test]
    fn unavailable_provider_detected() {
        let inp = input_with(
            vec![McpServerHealth {
                id: "1".into(),
                name: "srv".into(),
                enabled: true,
                healthy: false,
                error: Some("conn refused".into()),
            }],
            vec![],
            vec![],
        );
        let d = evaluate(&inp);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].class, DiagnosticClass::UnavailableProvider);
        assert!(d[0].detail.contains("conn refused"));
    }

    #[test]
    fn revoked_credential_detected_on_auth_error() {
        let inp = input_with(
            vec![McpServerHealth {
                id: "1".into(),
                name: "srv".into(),
                enabled: true,
                healthy: false,
                error: Some("HTTP 401 Unauthorized: invalid api key".into()),
            }],
            vec![],
            vec![],
        );
        let d = evaluate(&inp);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].class, DiagnosticClass::RevokedCredential);
        assert!(d[0].title.contains("凭证"));
        assert!(d[0].detail.contains("401"));
    }

    #[test]
    fn revoked_credential_403_also_detected() {
        let inp = input_with(
            vec![McpServerHealth {
                id: "1".into(),
                name: "srv".into(),
                enabled: true,
                healthy: false,
                error: Some("forbidden 403".into()),
            }],
            vec![],
            vec![],
        );
        let d = evaluate(&inp);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].class, DiagnosticClass::RevokedCredential);
    }

    #[test]
    fn missing_grant_detected_when_agent_skill_not_imported() {
        let mut inp = input_with(vec![], vec!["skill_a"], vec![]);
        inp.agent_skill_refs = vec![AgentSkillRef {
            agent_name: "研究员".into(),
            skill_id: "skill_gone".into(),
        }];
        let d = evaluate(&inp);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].class, DiagnosticClass::MissingGrant);
        assert!(d[0].scope.contains("研究员"));
        assert!(d[0].detail.contains("skill_gone"));
    }

    #[test]
    fn missing_grant_skipped_for_imported_skill_and_empty_ref() {
        let mut inp = input_with(vec![], vec!["skill_a"], vec![]);
        inp.agent_skill_refs = vec![
            AgentSkillRef {
                agent_name: "研究员".into(),
                skill_id: "skill_a".into(),
            },
            AgentSkillRef {
                agent_name: "空引用".into(),
                skill_id: "".into(),
            },
        ];
        assert!(evaluate(&inp).is_empty());
    }

    #[test]
    fn disabled_server_not_flagged_even_if_unhealthy() {
        let inp = input_with(
            vec![McpServerHealth {
                id: "1".into(),
                name: "srv".into(),
                enabled: false,
                healthy: false,
                error: Some("x".into()),
            }],
            vec![],
            vec![],
        );
        assert!(evaluate(&inp).is_empty());
    }

    #[test]
    fn orphaned_budget_detected() {
        let inp = input_with(vec![], vec!["ag_a"], vec!["ag_a", "ag_gone"]);
        let d = evaluate(&inp);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].class, DiagnosticClass::OrphanedGrant);
        assert!(d[0].scope.contains("ag_gone"));
    }

    #[test]
    fn valid_budget_not_flagged() {
        let inp = input_with(vec![], vec!["ag_a"], vec!["ag_a"]);
        assert!(evaluate(&inp).is_empty());
    }

    #[test]
    fn cli_executor_missing_detected() {
        let mut inp = input_with(vec![], vec![], vec![]);
        inp.cli_executors = vec![CliExecutorHealth {
            id: "cli:codex".into(),
            binary: "codex".into(),
            state: CliExecutorState::NotFound,
        }];
        let d = evaluate(&inp);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].class, DiagnosticClass::CliExecutorMissing);
        assert!(d[0].scope.contains("cli:codex"));
        assert!(d[0].detail.contains("PATH"));
    }

    #[test]
    fn cli_executor_launch_failed_detected() {
        let mut inp = input_with(vec![], vec![], vec![]);
        inp.cli_executors = vec![CliExecutorHealth {
            id: "cli:codex".into(),
            binary: "codex".into(),
            state: CliExecutorState::LaunchFailed,
        }];
        let d = evaluate(&inp);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].class, DiagnosticClass::CliExecutorLaunchFailed);
        assert!(d[0].title.contains("启动失败"));
        assert!(d[0].detail.contains("退出非零"));
    }

    #[test]
    fn cli_executor_available_not_flagged() {
        let mut inp = input_with(vec![], vec![], vec![]);
        inp.cli_executors = vec![CliExecutorHealth {
            id: "cli:codex".into(),
            binary: "codex".into(),
            state: CliExecutorState::Available,
        }];
        assert!(evaluate(&inp).is_empty());
    }

    #[test]
    fn cli_executor_auth_missing_detected() {
        let mut inp = input_with(vec![], vec![], vec![]);
        inp.cli_executors = vec![CliExecutorHealth {
            id: "cli:codex".into(),
            binary: "codex".into(),
            state: CliExecutorState::AuthMissing,
        }];
        let d = evaluate(&inp);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].class, DiagnosticClass::CliExecutorAuthMissing);
        assert!(d[0].title.contains("未登录"));
        assert!(d[0].fix_hint.contains("login"));
    }
}






use crate::agent::executor::AgentExecutor;
use crate::group::agent_repo::AgentProfileRepository;
use crate::mcp::manager::McpManager;
use crate::mcp::model::*;
use crate::config::load_config;
use crate::skill::budget::{SkillBudget, SkillBudgetTracker};
use crate::skill::manager::SkillManager;
use crate::skill::model::*;
use crate::skill::SqliteSkillBudgetTracker;
use crate::types::{McpServerDto, SkillDto};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::State;


pub struct ExtensibilityState {
    pub mcp: Arc<McpManager>,
    pub skill: Arc<SkillManager>,
    
    pub skill_budget: Arc<SqliteSkillBudgetTracker>,
    
    pub cli_executors: HashMap<String, Arc<dyn AgentExecutor>>,
    
    
    pub db: Arc<crate::DbConnection>,
}



#[tauri::command]
pub async fn list_mcp_servers(
    state: State<'_, ExtensibilityState>,
) -> Result<Vec<McpServerDto>, String> {
    state
        .mcp
        .list()
        .map_err(|e| e.to_string())
        .map(|v| v.into_iter().map(|s| s.to_dto()).collect())
}

#[tauri::command]
pub async fn add_mcp_server(
    state: State<'_, ExtensibilityState>,
    name: String,
    transport: String,
    command: Option<String>,
    args: Vec<String>,
    env: HashMap<String, String>,
    url: Option<String>,
    enabled: bool,
) -> Result<McpServerDto, String> {
    
    let mut _g = crate::commands::CmdLog::begin("add_mcp_server", &[
        ("name", name.clone()),
        ("transport", transport.clone()),
        ("command", command.clone().unwrap_or_default()),
        ("env_keys", env.keys().cloned().collect::<Vec<_>>().join(",")),
    ]);
    let payload = CreateMcpServerPayload {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        transport: McpTransport::from_str(&transport),
        command,
        args,
        env,
        url,
        enabled,
    };
    state
        .mcp
        .create(payload)
        .map_err(|e| e.to_string())
        .map(|s| s.to_dto())
}

#[tauri::command]
pub async fn set_mcp_enabled(
    state: State<'_, ExtensibilityState>,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    state
        .mcp
        .set_enabled(&id, enabled)
        .map_err(|e| e.to_string())
}




#[tauri::command]
pub async fn set_web_tools_enabled(
    state: State<'_, ExtensibilityState>,
    enabled: bool,
) -> Result<(), String> {
    let provider = load_config().search_provider;
    for id in ["fetch", provider.mcp_id()] {
        state
            .mcp
            .set_enabled(id, enabled)
            .map_err(|e| format!("启用 {} 失败: {}", id, e))?;
    }
    Ok(())
}


#[derive(Debug, serde::Serialize)]
pub struct WebToolsConfig {
    pub enabled: bool,
    pub provider: String,
    pub has_key: bool,
}

#[tauri::command]
pub async fn get_web_tools_config(
    state: State<'_, ExtensibilityState>,
) -> Result<WebToolsConfig, String> {
    let config = load_config();
    let provider = config.search_provider;
    let servers = state.mcp.list().map_err(|e| e.to_string())?;
    let fetch_on = servers.iter().any(|s| s.id == "fetch" && s.enabled);
    let search_on = servers
        .iter()
        .any(|s| s.id == provider.mcp_id() && s.enabled);
    let has_key = !config.active_search_key().is_empty();
    Ok(WebToolsConfig {
        enabled: fetch_on && search_on,
        provider: provider.to_string(),
        has_key,
    })
}

#[tauri::command]
pub async fn delete_mcp_server(
    state: State<'_, ExtensibilityState>,
    id: String,
) -> Result<(), String> {
    state.mcp.delete(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn test_mcp_connection(
    state: State<'_, ExtensibilityState>,
    id: String,
) -> Result<crate::mcp::manager::McpConnectionResult, String> {
    let mut _g = crate::commands::CmdLog::begin("test_mcp_connection", &[
        ("id", id.clone()),
    ]);
    let mcp = state.mcp.clone();
    let inner = tauri::async_runtime::spawn_blocking(move || mcp.test_connection(&id))
        .await
        .map_err(|e| e.to_string())??;
    if !inner.ok {
        _g.fail(&inner.error.clone().unwrap_or_default());
    }
    Ok(inner)
}



#[tauri::command]
pub async fn list_skills(state: State<'_, ExtensibilityState>) -> Result<Vec<SkillDto>, String> {
    state
        .skill
        .list()
        .map_err(|e| e.to_string())
        .map(|v| v.into_iter().map(|s| s.to_dto()).collect())
}

#[tauri::command]
pub async fn add_skill(
    state: State<'_, ExtensibilityState>,
    name: String,
    description: String,
    version: String,
) -> Result<SkillDto, String> {
    let payload = CreateSkillPayload {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        description,
        version,
        source: SkillSource::Builtin,
        path: None,
        url: None,
        status: SkillStatus::Enabled,
        dependencies: vec![],
    };
    state
        .skill
        .create(payload)
        .map_err(|e| e.to_string())
        .map(|s| s.to_dto())
}

#[tauri::command]
pub async fn import_skill_local(
    state: State<'_, ExtensibilityState>,
    path: String,
) -> Result<SkillDto, String> {
    state.skill.import_local(path).map(|s| s.to_dto())
}

#[tauri::command]
pub async fn import_skill_url(
    state: State<'_, ExtensibilityState>,
    url: String,
) -> Result<SkillDto, String> {
    state.skill.import_url(url).map(|s| s.to_dto())
}

#[tauri::command]
pub async fn set_skill_enabled(
    state: State<'_, ExtensibilityState>,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    state
        .skill
        .set_enabled(&id, enabled)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_skill(state: State<'_, ExtensibilityState>, id: String) -> Result<(), String> {
    state.skill.delete(&id).map_err(|e| e.to_string())
}






#[tauri::command]
pub async fn set_skill_budget(
    state: State<'_, ExtensibilityState>,
    id: String,
    token_limit: Option<i64>,
    cost_cents_limit: Option<i64>,
    time_secs_limit: Option<i64>,
) -> Result<(), String> {
    let budget = SkillBudget {
        token_limit: token_limit.map(|v| v as u64),
        cost_cents_limit: cost_cents_limit.map(|v| v as u64),
        time_secs_limit: time_secs_limit.map(|v| v as u64),
    };
    state.skill_budget.set_budget(&id, &budget)
}

#[tauri::command]
pub async fn get_skill_budget(
    state: State<'_, ExtensibilityState>,
    id: String,
) -> Result<SkillBudget, String> {
    Ok(state.skill_budget.get_budget(&id))
}








#[tauri::command]
pub async fn diagnose_capabilities(
    state: State<'_, ExtensibilityState>,
) -> Result<Vec<crate::diagnostics::CapabilityDiagnostic>, String> {
    use crate::agent::executor::ExecutorAvailability;
    use crate::diagnostics::{
        evaluate, CliExecutorHealth, CliExecutorState, DiagnosticInput, McpServerHealth,
    };

    
    
    let mut cli_health: Vec<CliExecutorHealth> = Vec::new();
    for (name, exec) in &state.cli_executors {
        let state_4 = match exec.probe_available().await {
            ExecutorAvailability::Available => CliExecutorState::Available,
            ExecutorAvailability::NotFound => CliExecutorState::NotFound,
            ExecutorAvailability::LaunchFailed => CliExecutorState::LaunchFailed,
            ExecutorAvailability::AuthMissing => CliExecutorState::AuthMissing,
        };
        let binary = name.strip_prefix("cli:").unwrap_or(name);
        cli_health.push(CliExecutorHealth {
            id: name.clone(),
            binary: binary.to_string(),
            state: state_4,
        });
    }

    
    let mcp = state.mcp.clone();
    let skill = state.skill.clone();
    let budget = state.skill_budget.clone();
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mcp_servers: Vec<McpServerHealth> = mcp
            .list()
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|s| {
                
                
                let err = mcp
                    .test_connection(&s.id)
                    .map(|r| r.error.clone().unwrap_or_default())
                    .unwrap_or_else(|e| e);
                let healthy = err.is_empty();
                McpServerHealth {
                    id: s.id,
                    name: s.name,
                    enabled: s.enabled,
                    healthy,
                    error: if healthy { None } else { Some(err) },
                }
            })
            .collect();
        let skill_ids = skill
            .list()
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|s| s.id)
            .collect();
        let budgeted_skill_ids = budget.list_budget_skill_ids();
        
        use crate::storage::repository::Repository;
        let mut agent_skill_refs: Vec<crate::diagnostics::AgentSkillRef> = Vec::new();
        for a in AgentProfileRepository::new(db.as_ref())
            .find_all(())
            .map_err(|e| e.to_string())?
        {
            for sid in &a.skills {
                agent_skill_refs.push(crate::diagnostics::AgentSkillRef {
                    agent_name: a.name.clone(),
                    skill_id: sid.clone(),
                });
            }
        }
        let input = DiagnosticInput {
            mcp_servers,
            skill_ids,
            budgeted_skill_ids,
            cli_executors: cli_health,
            agent_skill_refs,
        };
        Ok(evaluate(&input))
    })
    .await
    .map_err(|e| e.to_string())?
}





use crate::commands::extensibility::ExtensibilityState;
use crate::config::{load_config, save_config, SearchProvider};
use std::str::FromStr;
use tauri::State;

#[tauri::command]
pub async fn get_config_api_key() -> Result<String, String> {
    let config = load_config();
    Ok(config.api_key)
}

#[tauri::command]
pub async fn set_config_api_key(api_key: String) -> Result<(), String> {
    let mut config = load_config();
    config.api_key = api_key;
    save_config(&config)
}


#[tauri::command]
pub async fn get_search_provider() -> Result<String, String> {
    Ok(load_config().search_provider.to_string())
}



#[tauri::command]
pub async fn set_search_provider(
    provider: String,
    state: State<'_, ExtensibilityState>,
) -> Result<(), String> {
    let new_provider = SearchProvider::from_str(&provider)?;
    let mut config = load_config();
    let old_provider = config.search_provider;
    if old_provider == new_provider {
        return Ok(());
    }
    config.search_provider = new_provider;
    
    let key = config.active_search_key().to_string();
    if !key.is_empty() {
        std::env::set_var(new_provider.env_var(), key);
    }
    save_config(&config)?;

    
    let servers = state.mcp.list().map_err(|e| e.to_string())?;
    let fetch_on = servers.iter().any(|s| s.id == "fetch" && s.enabled);
    let old_search_on = servers
        .iter()
        .any(|s| s.id == old_provider.mcp_id() && s.enabled);
    if fetch_on && old_search_on {
        state
            .mcp
            .set_enabled(old_provider.mcp_id(), false)
            .map_err(|e| format!("禁用 {} 失败: {}", old_provider.mcp_id(), e))?;
        state
            .mcp
            .set_enabled(new_provider.mcp_id(), true)
            .map_err(|e| format!("启用 {} 失败: {}", new_provider.mcp_id(), e))?;
    }
    Ok(())
}


#[tauri::command]
pub async fn get_active_search_key() -> Result<String, String> {
    Ok(load_config().active_search_key().to_string())
}



#[tauri::command]
pub async fn set_active_search_key(key: String) -> Result<(), String> {
    let mut config = load_config();
    let provider = config.search_provider;
    *config.active_search_key_mut() = key.clone();
    save_config(&config)?;
    if !key.is_empty() {
        std::env::set_var(provider.env_var(), key);
    }
    Ok(())
}

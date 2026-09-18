




#![allow(dead_code)]

mod a2a;
mod agent;
mod commands;
mod config;
mod defaults;
mod diagnostics;
mod error;
mod events;
mod group;
mod llm;
mod mcp;
mod paths;
mod scheduler;
mod reminder;
mod seed;
mod session;
mod skill;
mod storage;
mod metrics;
mod types;

use std::sync::atomic::{AtomicU8, Ordering};


pub static STARTUP_PROGRESS: AtomicU8 = AtomicU8::new(0);


fn bump_progress(p: u8) {
    let prev = STARTUP_PROGRESS.load(Ordering::Relaxed);
    if p > prev {
        STARTUP_PROGRESS.store(p, Ordering::Relaxed);
        tracing::info!(target: "onedesktop", progress = p, "startup progress");
    }
}

#[cfg(test)]
mod integration_test;








pub fn wire_states<R: Runtime>(app: &AppHandle<R>, db: Arc<DbConnection>, start_scheduler: bool) {
    let metrics = Arc::new(Metrics::new());

    
    
    
    let agent_observer: Arc<dyn agent::ports::RunObserver> =
        Arc::new(agent::ports::TauriObserver::new(app.clone()));
    let event_bus: Arc<dyn agent::ports::EventBus> = agent::ports::TauriEventBus::new(app.clone());

    
    let session_manager = Arc::new(SessionManager::new(db.clone(), metrics.clone()));

    
    
    
    llm::set_custom_provider_defaults(llm::custom_defaults_from_settings(
        &session_manager.get_setting("custom_base_url").unwrap_or_default(),
        &session_manager.get_setting("token_config").unwrap_or_default(),
        &session_manager.get_setting("reasoning_dialect").unwrap_or_default(),
    ));
    
    llm::set_global_provider_name(&session_manager.get_setting("provider").unwrap_or_default());

    
    
    
    {
        let cfg = crate::config::load_config();
        let key = cfg.active_search_key().to_string();
        if !key.is_empty() {
            std::env::set_var(cfg.search_provider.env_var(), key);
        }
    }

    
    let mut tool_registry = agent::tool_registry::ToolRegistry::new();
    tool_registry.register(
        agent::tools::filesystem::ReadFileTool,
        agent::tools::filesystem::ReadFileTool,
    );
    tool_registry.register(
        agent::tools::filesystem::WriteFileTool,
        agent::tools::filesystem::WriteFileTool,
    );
    tool_registry.register(
        agent::tools::filesystem::ListDirTool,
        agent::tools::filesystem::ListDirTool,
    );
    tool_registry.register(
        agent::tools::shell::RunShellTool,
        agent::tools::shell::RunShellTool,
    );
    tool_registry.register(
        agent::tools::memory::UpdateMemoryTool,
        agent::tools::memory::UpdateMemoryTool,
    );
    tool_registry.register(
        agent::tools::weather::WeatherTool,
        agent::tools::weather::WeatherTool,
    );
    
    tool_registry.register(
        agent::tools::send_to_worker::SendToWorkerTool,
        agent::tools::send_to_worker::SendToWorkerTool,
    );
    
    tool_registry.register(
        agent::tools::blackboard::ReadStateTool,
        agent::tools::blackboard::ReadStateTool,
    );
    tool_registry.register(
        agent::tools::blackboard::UpdateStateTool,
        agent::tools::blackboard::UpdateStateTool,
    );

    
    
    for op in ["create", "list", "update", "delete"] {
        let t = agent::tools::calendar::CalendarTool::new(db.clone(), op);
        tool_registry.register(t.clone(), t);
    }
    for op in ["list", "create", "update", "delete", "set_enabled"] {
        let t = agent::tools::automation::AutomationTool::new(db.clone(), op);
        tool_registry.register(t.clone(), t);
    }
    for op in ["create", "list", "update", "delete"] {
        let t = agent::tools::kanban::KanbanTool::new(db.clone(), op);
        tool_registry.register(t.clone(), t);
    }
    
    
    tool_registry.register(
        agent::tools::group_assign::AssignTasksTool,
        agent::tools::group_assign::AssignTasksTool,
    );

    let tool_registry = Arc::new(tool_registry);

    
    
    
    let plane: Arc<dyn agent::toolplane::ToolPlane> =
        Arc::new(agent::toolplane::ToolPlaneImpl::new());
    plane.register_provider(Arc::new(agent::toolplane::BuiltinProvider::new(
        tool_registry.clone(),
    )));

    
    
    let ledger = std::sync::Arc::new(agent::ledger_sqlite::SqliteRunLedger::new(db.clone()));
    
    
    
    let blackboard = std::sync::Arc::new(agent::blackboard_sqlite::SqliteBlackboard::new(db.clone()));
    
    
    
    let message_bus = std::sync::Arc::new(agent::message_bus_sqlite::SqliteMessageBus::new(db.clone()));
    
    let approval = std::sync::Arc::new(agent::approval::ApprovalBroker::new());
    
    let approval_gate: Arc<dyn agent::ports::ApprovalGate> = approval.clone();
    
    let skill_budget =
        std::sync::Arc::new(crate::skill::budget_repo::SqliteSkillBudgetTracker::new(db.clone()));
    
    let write_gate = std::sync::Arc::new(agent::write_gate::WriteGate::new(Some(Box::new(
        crate::storage::changeset_sqlite::SqliteChangesetRecorder::new(db.clone()),
    ))));
    let engine = agent::engine::AgentLoopEngine::new(
        session_manager.clone(),
        plane.clone(),
        metrics,
        ledger,
        approval,
        skill_budget.clone(),
        
        blackboard.clone(),
        
        std::sync::Arc::new(std::sync::RwLock::new(None)),
        
        write_gate.clone(),
    );
    let engine = Arc::new(engine);

    
    let mcp_manager = Arc::new(McpManager::new(db.clone()));
    
    for srv in mcp_manager.list().unwrap_or_default() {
        if srv.enabled {
            plane.register_provider(Arc::new(crate::mcp::tool_provider::McpToolProvider::new(srv)));
        }
    }
    let skill_manager = Arc::new(SkillManager::new(db.clone()));
    
    
    let cli_executors = crate::agent::executor::cli::default_cli_executors(
        Some(approval_gate.clone()),
        Some(event_bus.clone()),
    );
    let extensibility = ExtensibilityState {
        mcp: mcp_manager,
        skill: skill_manager.clone(),
        skill_budget: skill_budget.clone(),
        cli_executors: cli_executors.clone(),
        db: db.clone(),
    };

    
    let scheduler = Scheduler::new(
        db.clone(),
        agent_observer.clone(),
        event_bus.clone(),
        engine.clone(),
        session_manager.clone(),
        skill_manager.clone(),
    );
    app.manage(SchedulerState(scheduler.clone()));
    if start_scheduler {
        scheduler.start();
    }

    
    app.manage(SessionState(session_manager.clone()));
    app.manage(AgentState {
        engine: engine.clone(),
    });
    app.manage(extensibility);
    
    app.manage(crate::commands::agent::ToolPlaneState(plane));
    
    app.manage(crate::commands::group::GroupState { db: db.clone() });
    
    app.manage(crate::commands::calendar::CalendarState { db: db.clone() });
    
    app.manage(crate::commands::workspace::WorkspaceState { db: db.clone() });
    
    app.manage(blackboard);
    app.manage(message_bus);
    
    
    
    let task_heartbeat: Arc<dyn crate::agent::ports::TaskHeartbeat> =
        Arc::new(crate::agent::heartbeat_sqlite::SqliteTaskHeartbeat::new(db.clone()));
    let executor: Arc<dyn crate::agent::executor::AgentExecutor> =
        Arc::new(crate::agent::executor::InternalExecutor::new(
            engine.clone(),
            session_manager.clone(),
            agent_observer.clone(),
            task_heartbeat.clone(),
        ));
    
    
    let task_scheduler = Arc::new(TaskScheduler::new(
        db.clone(),
        engine.clone(),
        executor,
        cli_executors,
        session_manager.clone(),
        event_bus.clone(),
        task_heartbeat.clone(),
    ));
    
    TaskScheduler::set_scheduler_handle(task_scheduler.clone());
    
    
    
    crate::group::scheduler::recover_orphan_dag_tasks(&db, &event_bus);
    
    
    let healed_calls = crate::storage::session_event_repo::heal_pending_tool_calls(&db);
    if healed_calls > 0 {
        tracing::info!(target: "onedesktop", healed = healed_calls, "session event log: healed dangling tool calls on startup");
    }
    
    
    
    
    
    
    
    if start_scheduler {
        let sweeper_scheduler = task_scheduler.clone();
        tauri::async_runtime::spawn(async move {
            sweeper_scheduler.run_sweeper_loop(60, 1).await;
        });
    }
    app.manage(task_scheduler);
    
    
    let roundtable_bus = std::sync::Arc::new(RoundtableBus::new(
        db.clone(),
        engine.clone(),
        session_manager.clone(),
        agent_observer.clone(),
        event_bus.clone(),
    ));
    
    engine.set_group_sender(roundtable_bus.clone());
    app.manage(roundtable_bus);
}


#[allow(deprecated)]
use commands::agent::{
    approve_tool, cancel_agent, clear_tool_permission, decide_approval, decide_approval_batch,
    decide_proposal,
    exempt_tool_for_session, list_tool_permissions, reset_tool_permissions, send_message,
    set_auto_approve, set_tool_permission, AgentState,
};
use commands::config::{
    get_active_search_key, get_config_api_key, get_search_provider, set_active_search_key,
    set_config_api_key, set_search_provider,
};
use commands::extensibility::{
    add_mcp_server, add_skill, delete_mcp_server, delete_skill, diagnose_capabilities,
    get_skill_budget, get_web_tools_config, import_skill_local, import_skill_url, list_mcp_servers,
    list_skills, set_mcp_enabled, set_skill_budget, set_skill_enabled, set_web_tools_enabled,
    test_mcp_connection, ExtensibilityState,
};
use commands::ping;
use commands::startup_progress;
use commands::scheduler::{
    create_scheduled_task, delete_scheduled_task, list_scheduled_tasks, run_task_now,
    update_scheduled_task,
    set_task_paused, SchedulerState,
};
use commands::session::{
    create_session, delete_session, get_messages, get_session, get_setting, get_trace,
    has_active_run, list_active_runs, list_sessions, set_setting, SessionState,
};
use group::roundtable::RoundtableBus;
use group::scheduler::TaskScheduler;
use mcp::McpManager;
use scheduler::Scheduler;
use session::manager::SessionManager;
use skill::SkillManager;
use std::sync::Arc;
use storage::connection::DbConnection;
use tauri::{AppHandle, Manager, Runtime};
use metrics::metrics::Metrics;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            bump_progress(5);
            
            paths::ensure_dirs();
            paths::migrate_legacy();
            agent::tools::memory::ensure_memory_files();
            tracing::info!(target: "onedesktop", data_dir = %paths::data_dir().display(), "Data directory");
            bump_progress(15);

            
            metrics::logger::init();
            tracing::info!(target: "onedesktop", "OneDesktop starting up");
            bump_progress(30);

            
            let db = DbConnection::open(&paths::db_dir())
                .expect("Failed to open database");
            let db = Arc::new(db);
            bump_progress(50);

            
            seed::seed_defaults(&db);
            
            seed::seed_demo_data(&db);
            
            seed::seed_demo_tasks(&db);
            bump_progress(70);

            
            
            
            
            storage::longtask_repo::recover_in_flight_tasks(&db);

            
            wire_states(app.handle(), db.clone(), true);
            bump_progress(90);

            
            
            
            #[cfg(target_os = "macos")]
            {
                if let Some(w) = tauri::Manager::get_window(app, "main") {
                    let _ = tauri_plugin_trafficlights_positioner::WindowExt::setup_traffic_lights_inset(
                        &w,
                        tauri::LogicalPosition::new(19.0_f64, 20.0_f64),
                    );
                }
            }

            
            {
                let app_handle = app.handle().clone();
                let reminder_db = db.clone();
                tauri::async_runtime::spawn(async move {
                    reminder::run_reminder_loop(app_handle, reminder_db).await;
                });
            }

            tracing::info!(
                target: "onedesktop",
                "OneDesktop initialized successfully"
            );
            bump_progress(100);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            
            create_session,
            get_session,
            list_sessions,
            delete_session,
            get_messages,
            get_trace,
            has_active_run,
            list_active_runs,
            get_setting,
            set_setting,
            
            send_message,
            #[allow(deprecated)]
            approve_tool,
            decide_approval,
            decide_approval_batch,
            decide_proposal,
            exempt_tool_for_session,
            cancel_agent,
            commands::agent::steer_agent,
            set_auto_approve,
            list_tool_permissions,
            set_tool_permission,
            reset_tool_permissions,
            clear_tool_permission,
            
            get_config_api_key,
            set_config_api_key,
            get_search_provider,
            set_search_provider,
            get_active_search_key,
            set_active_search_key,
            
            list_mcp_servers,
            add_mcp_server,
            set_mcp_enabled,
            delete_mcp_server,
            test_mcp_connection,
            set_web_tools_enabled,
            get_web_tools_config,
            list_skills,
            add_skill,
            import_skill_local,
            import_skill_url,
            set_skill_enabled,
            delete_skill,
            set_skill_budget,
            get_skill_budget,
            diagnose_capabilities,
            
            list_scheduled_tasks,
            create_scheduled_task,
            set_task_paused,
            delete_scheduled_task,
            run_task_now,
            update_scheduled_task,
            
            
            crate::commands::longtask::list_interruptions,
            crate::commands::longtask::get_task_checkpoint,
            crate::commands::longtask::pause_task,
            crate::commands::longtask::resume_task,
            crate::commands::longtask::dismiss_interruption,
            crate::commands::longtask::dismiss_all_interruptions,
            
            ping,
            
            startup_progress,
            
            crate::commands::group::create_agent_preset,
            crate::commands::group::list_agent_presets,
            crate::commands::group::update_agent_preset,
            crate::commands::group::delete_agent_preset,
            
            crate::commands::group::scan_local_agents,
            crate::commands::group::import_agent,
            crate::commands::group::export_agent,
            
            crate::commands::group::create_group,
            crate::commands::group::list_groups,
            crate::commands::group::get_group,
            crate::commands::group::group_pause,
            crate::commands::group::group_resume,
            crate::commands::group::group_dissolve,
            crate::commands::group::group_add_worker,
            crate::commands::group::group_add_capability_seat,
            crate::commands::group::group_set_worker_status,
            crate::commands::group::group_set_worker_agent,
            crate::commands::group::group_remove_worker,
            crate::commands::group::group_assign_tasks,
            crate::commands::group::group_list_workers,
            crate::commands::group::group_list_tasks,
            crate::commands::group::group_approve_batch,
            crate::commands::group::group_cancel_batch,
            crate::commands::group::group_get_workspace,
            
            crate::commands::group::workspace_reveal,
            
            crate::commands::group::task_retry,
            crate::commands::group::task_reassign,
            crate::commands::group::task_skip_dependency,
            crate::commands::group::task_set_status,
            crate::commands::group::task_attach_outputs,
            crate::commands::group::task_launch,
            crate::commands::group::task_reorder,
            crate::commands::group::task_list_all,
            crate::commands::group::task_create,
            
            crate::commands::group::group_post_message,
            crate::commands::group::group_roundtable_broadcast,
            
            crate::commands::group::group_topology_get,
            crate::commands::group::group_topology_set,
            
            crate::commands::group::group_blackboard_get,
            crate::commands::group::group_blackboard_set,
            
            crate::commands::group::group_create_from_manifest,
            crate::commands::group::group_list_messages,
            crate::commands::group::group_list_alternatives,
            crate::commands::group::group_pick_alternative,
            crate::commands::group::group_rerun_from_message,
            crate::commands::group::group_roundtable_summarize,
            crate::commands::group::group_list_summaries,
            crate::commands::group::group_list_deliverables,
            crate::commands::group::group_list_worker_metrics,
            
            crate::commands::insight::insight_group_runs,
            crate::commands::insight::insight_seat_runs,
            
            crate::commands::insight::export_run_replay,
            
            crate::commands::upgrade::session_upgrade_propose,
            crate::commands::upgrade::session_confirm_upgrade,
            crate::commands::upgrade::session_fold_to_chat,
            
            crate::commands::memory::memory_distill,
            crate::commands::memory::memory_search,
            
            crate::commands::user_profile::user_profile_read,
            crate::commands::user_profile::user_profile_write,
            
            crate::commands::inspiration::suggest_inspiration_tags,
            crate::commands::inspiration::list_inspirations,
            crate::commands::inspiration::create_inspiration,
            crate::commands::inspiration::delete_inspiration,
            
            crate::commands::workspace::list_workspaces,
            crate::commands::workspace::create_workspace,
            crate::commands::workspace::create_workspace_with_path,
            crate::commands::workspace::rename_workspace,
            crate::commands::workspace::delete_workspace,
            crate::commands::workspace::list_workspace_files,
            crate::commands::workspace::list_model_files,
            crate::commands::workspace::list_workspace_file_tree,
            
            crate::commands::artifact::artifact_read_text,
            crate::commands::artifact::artifact_read_base64,
            
            crate::commands::attachment::save_paste_attachment,
            crate::commands::attachment::import_attachment,
            
            crate::commands::playbook::playbook_list,
            crate::commands::playbook::playbook_save,
            crate::commands::playbook::playbook_delete,
            
            crate::commands::changeset::group_changesets,
            crate::commands::changeset::run_changesets,
            crate::commands::changeset::run_changeset_versions,
            crate::commands::changeset::changeset_rollback,
            crate::commands::changeset::session_changesets,
            
            crate::commands::calendar::calendar_event_create,
            crate::commands::calendar::calendar_event_list_by_month,
            crate::commands::calendar::calendar_event_update,
            crate::commands::calendar::calendar_event_delete,
            
            crate::reminder::reminder_notify_test,
        ])
        .run(tauri::generate_context!())
        .expect("error while running OneDesktop");
}

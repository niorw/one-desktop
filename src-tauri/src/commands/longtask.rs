





















use crate::agent::engine::{ResumePoint, RunRequest};
use crate::agent::ledger::RunKind;
use crate::agent::ports::{RunObserver, TauriObserver};
use crate::commands::agent::{AgentState, resolve_workspace_root};
use crate::commands::scheduler::SchedulerState;
use crate::commands::session::SessionState;
use crate::config::load_config;
use crate::llm;
use crate::llm::providers::deepseek::ThinkingMode;
use crate::storage::connection::DbConnection;
use crate::storage::longtask_repo::{LongTaskRepository, ResumableRun};
use std::sync::Arc;
use tauri::{AppHandle, State};



const DEFAULT_LIST_LIMIT: u32 = 50;




fn resolve_run(
    db: &DbConnection,
    run_id: Option<&str>,
    job_id: Option<&str>,
    session_id: Option<&str>,
) -> Result<ResumableRun, String> {
    let repo = LongTaskRepository::new(db);
    let found = if let Some(id) = run_id {
        repo.get_run(id).map_err(|e| e.to_string())?
    } else if let Some(id) = job_id {
        repo.latest_run_of_job(id).map_err(|e| e.to_string())?
    } else if let Some(id) = session_id {
        repo.latest_run_of_session(id).map_err(|e| e.to_string())?
    } else {
        return Err("resolve_run: 需要 run_id / job_id / session_id 三者之一".into());
    };
    found.ok_or_else(|| "找不到对应的运行记录".to_string())
}







#[tauri::command]
pub async fn list_interruptions(
    state: State<'_, SchedulerState>,
    limit: Option<u32>,
) -> Result<Vec<ResumableRun>, String> {
    let mut g = crate::commands::CmdLog::begin(
        "list_interruptions",
        &[("limit", limit.unwrap_or(DEFAULT_LIST_LIMIT).to_string())],
    );
    let db = &state.0.db;
    let auto_clean = crate::storage::longtask_repo::read_auto_clean(db);
    let retention_days = crate::storage::longtask_repo::read_retention_days(db).max(0);
    
    let cutoff = if auto_clean && retention_days > 0 {
        crate::agent::ledger::now_unix_ms() - retention_days * 86_400_000
    } else {
        0
    };
    LongTaskRepository::new(db)
        .list_recoverable(cutoff, limit.unwrap_or(DEFAULT_LIST_LIMIT))
        .map_err(|e| {
            let msg = e.to_string();
            g.fail(&msg);
            msg
        })
}




#[tauri::command]
pub async fn dismiss_interruption(
    state: State<'_, SchedulerState>,
    run_id: String,
) -> Result<(), String> {
    let mut g = crate::commands::CmdLog::begin("dismiss_interruption", &[("run_id", run_id.clone())]);
    LongTaskRepository::new(&state.0.db)
        .dismiss_interruption(&run_id)
        .map(|_| ())
        .map_err(|e| {
            let msg = e.to_string();
            g.fail(&msg);
            msg
        })
}


#[tauri::command]
pub async fn dismiss_all_interruptions(
    state: State<'_, SchedulerState>,
) -> Result<(), String> {
    let _g = crate::commands::CmdLog::begin("dismiss_all_interruptions", &[]);
    LongTaskRepository::new(&state.0.db)
        .dismiss_all_interruptions()
        .map(|_| ())
        .map_err(|e| e.to_string())
}




#[tauri::command]
pub async fn get_task_checkpoint(
    state: State<'_, SchedulerState>,
    run_id: Option<String>,
    job_id: Option<String>,
    session_id: Option<String>,
) -> Result<Option<ResumableRun>, String> {
    let _g = crate::commands::CmdLog::begin(
        "get_task_checkpoint",
        &[
            ("run_id", run_id.clone().unwrap_or_default()),
            ("job_id", job_id.clone().unwrap_or_default()),
            ("session_id", session_id.clone().unwrap_or_default()),
        ],
    );
    
    
    if run_id.is_none() && job_id.is_none() && session_id.is_none() {
        return Err("get_task_checkpoint: 需要 run_id / job_id / session_id 三者之一".into());
    }
    Ok(resolve_run(
        &state.0.db,
        run_id.as_deref(),
        job_id.as_deref(),
        session_id.as_deref(),
    )
    .ok())
}








#[tauri::command]
pub async fn pause_task(
    agent_state: State<'_, AgentState>,
    scheduler_state: State<'_, SchedulerState>,
    session_id: Option<String>,
    job_id: Option<String>,
) -> Result<bool, String> {
    let mut g = crate::commands::CmdLog::begin(
        "pause_task",
        &[
            ("session_id", session_id.clone().unwrap_or_default()),
            ("job_id", job_id.clone().unwrap_or_default()),
        ],
    );
    
    let sid = match session_id {
        Some(s) => s,
        None => {
            let job = job_id
                .as_deref()
                .ok_or_else(|| "pause_task: 需要 session_id 或 job_id".to_string())
                .inspect_err(|e| g.fail(e))?;
            resolve_run(&scheduler_state.0.db, None, Some(job), None)
                .inspect_err(|e| g.fail(e))?
                .session_id
        }
    };
    Ok(agent_state.engine.pause(&sid).await)
}





#[tauri::command]
pub async fn resume_task(
    app: AppHandle,
    agent_state: State<'_, AgentState>,
    session_state: State<'_, SessionState>,
    scheduler_state: State<'_, SchedulerState>,
    run_id: Option<String>,
    job_id: Option<String>,
    session_id: Option<String>,
) -> Result<String, String> {
    let mut g = crate::commands::CmdLog::begin(
        "resume_task",
        &[
            ("run_id", run_id.clone().unwrap_or_default()),
            ("job_id", job_id.clone().unwrap_or_default()),
            ("session_id", session_id.clone().unwrap_or_default()),
        ],
    );
    let db = scheduler_state.0.db.clone();
    let run = resolve_run(
        &db,
        run_id.as_deref(),
        job_id.as_deref(),
        session_id.as_deref(),
    )
    .inspect_err(|e| g.fail(e))?;

    
    if !LongTaskRepository::is_resumable_kind(&run.kind) {
        let msg = format!("{} 类型的运行由群编排层管理，不支持在此续跑", run.kind);
        g.fail(&msg);
        return Err(msg);
    }
    
    
    if let Some(job_id) = &run.job_id {
        let is_dag_run = db
            .with_conn(|c| -> rusqlite::Result<bool> {
                Ok(c.query_row("SELECT 1 FROM tasks WHERE id = ?1", rusqlite::params![job_id], |_| Ok(()))
                    .is_ok())
            })
            .unwrap_or(false);
        if is_dag_run {
            let msg = "该运行属于 DAG 任务，请在依赖拓扑中重新启动（断点续跑会自动生效）".to_string();
            g.fail(&msg);
            return Err(msg);
        }
    }
    if !matches!(run.status.as_str(), "paused" | "interrupted") {
        let msg = format!("运行状态为 {}，不可续跑", run.status);
        g.fail(&msg);
        return Err(msg);
    }
    
    if agent_state.engine.is_running(&run.session_id).await {
        let msg = "该会话正在运行中，无需续跑".to_string();
        g.fail(&msg);
        return Err(msg);
    }

    
    let cfg = load_config();
    if cfg.api_key.is_empty() {
        let msg = "API key 未配置，请在设置中填写".to_string();
        g.fail(&msg);
        return Err(msg);
    }
    let mgr = &session_state.0;
    let provider_name = mgr
        .get_setting("provider")
        .unwrap_or_else(|_| "deepseek".into());
    
    let model = run
        .model
        .clone()
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| {
            mgr.get_setting("model")
                .unwrap_or_else(|_| crate::defaults::DEFAULT_MODEL.into())
        });
    let preamble = mgr.get_setting("preamble").unwrap_or_default();
    
    
    
    let workspace_root = resolve_workspace_root(&db, &run.session_id).await;
    let mut preamble = if let Some(root) = &workspace_root {
        crate::commands::agent::append_workspace_knowledge(&preamble, root)
    } else {
        preamble
    };
    let effective_root = match workspace_root {
        Some(r) => r,
        None => crate::commands::agent::default_session_root(&run.session_id),
    };
    
    
    let tmp_root = crate::paths::session_tmp_root(&run.session_id);
    let ws_note = if run.kind == RunKind::Scheduled.as_str() {
        format!(
            "\n\n[Workspace] Your working directory is: {}\nUse relative paths for file operations; all files are confined to this directory.\n\
             [Temp] Temporary / intermediate files go under: {} (per-session).",
            effective_root.display(),
            tmp_root.display()
        )
    } else {
        format!(
            "\n\n[Workspace] Your default working directory is: {}\n\
             Use relative paths for file operations so your outputs land there. \
             If the user asks you to save files to a specific location (an absolute path), write there instead.\n\
             [Temp] Temporary / intermediate / scratch files go under: {} (per-session). \
             Prefer it over the system /tmp so cleanup is contained.",
            effective_root.display(),
            tmp_root.display()
        )
    };
    preamble = format!("{}{}", preamble, ws_note);
    let temperature: f64 = mgr
        .get_setting("temperature")
        .unwrap_or_else(|_| "0.7".into())
        .parse()
        .unwrap_or(0.7);
    let max_tokens: u32 = mgr
        .get_setting("max_tokens")
        .unwrap_or_else(|_| "0".into())
        .parse()
        .unwrap_or(0);
    let max_iterations: u32 = mgr
        .get_setting("max_iterations")
        .unwrap_or_else(|_| "200".into())
        .parse()
        .unwrap_or(200);
    let token_budget: u64 = mgr
        .get_setting("token_budget")
        .unwrap_or_else(|_| "500000".into())
        .parse()
        .unwrap_or(500000);

    
    if run.iteration >= max_iterations {
        let msg = format!(
            "已完成 {} 轮，达到迭代上限 {}，请提高上限或改为新任务",
            run.iteration, max_iterations
        );
        g.fail(&msg);
        return Err(msg);
    }

    
    
    
    if let Err(e) = LongTaskRepository::new(&db).mark_superseded(&run.run_id) {
        let msg = format!("标记原运行失败：{}", e);
        g.fail(&msg);
        return Err(msg);
    }

    let engine = agent_state.engine.clone();
    let observer: Arc<dyn RunObserver> = Arc::new(TauriObserver::new(app.clone()));
    
    
    let sm = agent_state.engine.session_manager();
    let history = sm.get_messages(&run.session_id).unwrap_or_default();
    let task_prompt = history
        .iter()
        .find(|m| m.role == "user")
        .map(|m| m.content.clone())
        .unwrap_or_default();
    let thinking_raw = sm.get_setting("thinking_mode").unwrap_or_default();
    let thinking = ThinkingMode::from_setting(&thinking_raw).resolve_auto(&task_prompt, history.len());
    let provider = llm::create_provider_full(
        &provider_name,
        cfg.api_key,
        model.clone(),
        thinking,
        None,
        None,
        None,
    );
    let resumed_session = run.session_id.clone();
    let is_scheduled = run.kind == RunKind::Scheduled.as_str();
    let resume_point = ResumePoint {
        iteration: run.iteration,
        tokens_used: run.tokens_used,
        job_id: run.job_id.clone(),
        attempt_no: run.attempt_no,
    };

    tracing::info!(
        target: "onedesktop.longtask",
        run_id = %run.run_id,
        session_id = %resumed_session,
        job_id = ?run.job_id,
        from_iteration = run.iteration,
        prior_tokens = run.tokens_used,
        attempt_no = run.attempt_no + 1,
        "resume_task 启动续跑"
    );

    let session_for_task = resumed_session.clone();
    let job_for_task = run.job_id.clone();
    tauri::async_runtime::spawn(async move {
        let outcome = engine
            .run_guarded(
                observer,
                RunRequest {
                    session_id: session_for_task.clone(),
                    
                    
                    user_message: String::new(),
                    provider,
                    preamble: preamble.to_string(),
                    temperature,
                    max_tokens_per_call: max_tokens,
                    max_iterations: Some(max_iterations),
                    token_budget: Some(token_budget),
                    
                    workspace_root: Some(effective_root.clone()),
                    
                    auto_approve_override: if is_scheduled { Some(true) } else { None },
                    trace_id: None,
                    kind: if is_scheduled {
                        RunKind::Scheduled
                    } else {
                        RunKind::Chat
                    },
                    group_id: None,
                    seat_id: None,
                    model: Some(model.to_string()),
                    
                    
                    tool_scope: if is_scheduled {
                        Some(crate::agent::toolplane::ToolScope::only(
                            crate::agent::permission::SAFE_TOOLS,
                        ))
                    } else {
                        None
                    },
                    session_kind: if is_scheduled {
                        crate::agent::permission::SessionKind::UnattendedWorker
                    } else {
                        crate::agent::permission::SessionKind::User
                    },
                    resume: Some(resume_point),
                    task_id: job_for_task.clone(),
                },
            )
            .await;
        
        if let Some(job) = job_for_task.as_deref() {
            let _ = LongTaskRepository::new(&db).stamp_job_finished(job, &outcome.run_id);
        }
        tracing::info!(
            target: "onedesktop.longtask",
            session_id = %session_for_task,
            run_id = %outcome.run_id,
            stop_reason = ?outcome.stop_reason,
            iterations = outcome.iterations,
            "resume_task 续跑结束"
        );
    });

    Ok(resumed_session)
}

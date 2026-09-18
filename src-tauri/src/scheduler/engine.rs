









use crate::agent::engine::{AgentLoopEngine, RunRequest};
use crate::agent::ledger::RunKind;
use crate::agent::ports::{EventBus, RunObserver};
use crate::config;
use crate::llm;
use crate::scheduler::model::*;
use crate::session::manager::SessionManager;
use crate::skill::SkillManager;
use crate::storage::connection::DbConnection;
use crate::storage::longtask_repo::LongTaskRepository;
use crate::storage::task_repo::TaskRepository;
use std::sync::Arc;
use tokio::process::Command as TokioCommand;
use tokio::time::{interval, Duration as TokioDuration};






pub struct Scheduler {
    pub(crate) db: Arc<DbConnection>,
    observer: Arc<dyn RunObserver>,
    bus: Arc<dyn EventBus>,
    engine: Arc<AgentLoopEngine>,
    session_mgr: Arc<SessionManager>,
    
    skill_mgr: Arc<SkillManager>,
}

impl Scheduler {
    pub fn new(
        db: Arc<DbConnection>,
        observer: Arc<dyn RunObserver>,
        bus: Arc<dyn EventBus>,
        engine: Arc<AgentLoopEngine>,
        session_mgr: Arc<SessionManager>,
        skill_mgr: Arc<SkillManager>,
    ) -> Arc<Self> {
        Arc::new(Self {
            db,
            observer,
            bus,
            engine,
            session_mgr,
            skill_mgr,
        })
    }

    
    pub fn start(self: Arc<Self>) {
        let scheduler = self;
        tauri::async_runtime::spawn(async move {
            scheduler.recompute_all();
            let mut ticker = interval(TokioDuration::from_secs(1));
            loop {
                ticker.tick().await;
                Self::tick(&scheduler).await;
            }
        });
        tracing::info!(target: "onedesktop.scheduler", "Scheduler started");
    }

    
    fn recompute_all(&self) {
        if let Ok(tasks) = TaskRepository::new(&self.db).find_active() {
            for t in tasks {
                if t.next_run_at.is_none() {
                    Self::recompute_next(&self.db, &t);
                }
            }
        }
    }

    async fn tick(scheduler: &Arc<Self>) {
        let now = chrono::Utc::now();
        let tasks = match TaskRepository::new(&scheduler.db).find_active() {
            Ok(t) => t,
            Err(_) => return,
        };
        for task in tasks {
            let due = task
                .next_run_at
                .as_ref()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|d| d.with_timezone(&chrono::Utc) <= now)
                .unwrap_or(false);
            if due {
                let s = scheduler.clone();
                let t = task.clone();
                tauri::async_runtime::spawn(async move {
                    s.execute(t).await;
                });
            }
        }
    }

    
    pub fn execute_now(self: Arc<Self>, task: ScheduledTask) {
        tauri::async_runtime::spawn(async move {
            self.execute(task).await;
        });
    }

    
    pub(crate) async fn execute(&self, task: ScheduledTask) {
        let now = chrono::Utc::now();

        let (success, message) = match task.action_type {
            ActionType::Agent => {
                if let Ok(payload) = serde_json::from_str::<AgentAction>(&task.action_payload) {
                    match self.run_agent(&task.id, &task.title, &payload.prompt).await {
                        Ok(msg) => (true, msg),
                        Err(e) => (false, e),
                    }
                } else {
                    (false, "无效的 action payload".to_string())
                }
            }
            ActionType::Shell => {
                if let Ok(payload) = serde_json::from_str::<ShellAction>(&task.action_payload) {
                    match run_shell(&payload.command).await {
                        Ok(out) => (true, out),
                        Err(e) => (false, e),
                    }
                } else {
                    (false, "无效的 action payload".to_string())
                }
            }
            ActionType::Skill => {
                if let Ok(payload) = serde_json::from_str::<SkillAction>(&task.action_payload) {
                    
                    match self.skill_mgr.read_l2(&payload.skill_id) {
                        Some(body) => {
                            match self
                                .run_agent(&task.id, &format!("skill:{}", payload.skill_id), &body)
                                .await
                            {
                                Ok(msg) => (true, msg),
                                Err(e) => (false, e),
                            }
                        }
                        None => (
                            false,
                            format!("Skill {} 未找到或无可读正文（L2）", payload.skill_id),
                        ),
                    }
                } else {
                    (false, "无效的 skill action payload".to_string())
                }
            }
        };

        let new_count = task.run_count + 1;
        let (status, next) = match task.type_ {
            TaskType::Once => {
                let st = if success {
                    TaskStatus::Completed
                } else {
                    TaskStatus::Failed
                };
                (st, None)
            }
            _ => {
                
                let next = Schedule::parse(task.type_.as_str(), &task.schedule_expr)
                    .ok()
                    .and_then(|s| s.next_after(chrono::Utc::now()))
                    .map(|d| d.to_rfc3339());
                (TaskStatus::Active, next)
            }
        };

        let _ = TaskRepository::new(&self.db).record_run(
            &task.id,
            &now.to_rfc3339(),
            new_count,
            status.as_str(),
            next.as_deref(),
        );

        emit_task_event(&self.bus, &task.id, success, &message, new_count);
        tracing::info!(
            target: "onedesktop.scheduler",
            task_id = %task.id,
            success = success,
            run_count = new_count,
            "Task executed"
        );
    }

    
    
    
    
    
    async fn run_agent(&self, task_id: &str, title: &str, prompt: &str) -> Result<String, String> {
        let cfg = config::load_config();
        if cfg.api_key.is_empty() {
            return Err("未配置 API Key，无法执行 Agent 任务".to_string());
        }
        let provider_name = self
            .session_mgr
            .get_setting("provider")
            .unwrap_or_else(|_| "deepseek".to_string());
        let model = self
            .session_mgr
            .get_setting("model")
            .unwrap_or_else(|_| crate::defaults::DEFAULT_MODEL.to_string());
        let preamble = self.session_mgr.get_setting("preamble").unwrap_or_default();
        let temperature: f64 = self
            .session_mgr
            .get_setting("temperature")
            .unwrap_or_else(|_| "0.7".to_string())
            .parse()
            .unwrap_or(0.7);
        let max_tokens: u32 = self
            .session_mgr
            .get_setting("max_tokens")
            .unwrap_or_else(|_| "0".to_string())
            .parse()
            .unwrap_or(0);
        let max_iterations: u32 = self
            .session_mgr
            .get_setting("max_iterations")
            .unwrap_or_else(|_| "200".to_string())
            .parse()
            .unwrap_or(200);
        let token_budget: u64 = self
            .session_mgr
            .get_setting("token_budget")
            .unwrap_or_else(|_| "0".to_string())
            .parse()
            .unwrap_or(0);

        let provider = llm::create_provider(&provider_name, cfg.api_key, model.clone());
        let session = self
            .session_mgr
            .create_session(format!("⏰ {}", title), model.clone(), preamble.clone(), None)
            .map_err(|e| e.to_string())?;
        
        
        if let Err(e) =
            LongTaskRepository::new(&self.db).stamp_job_started(task_id, &session.id)
        {
            tracing::warn!(
                target: "onedesktop.scheduler",
                task_id = %task_id,
                error = %e,
                "写入 job 恢复锚点失败（任务继续执行）"
            );
        }
        let observer = self.observer.clone();
        let outcome = self
            .engine
            .clone()
            .run_guarded(
                observer,
                RunRequest {
                    session_id: session.id.clone(),
                    user_message: prompt.to_string(),
                    provider,
                    preamble: preamble.to_string(),
                    temperature,
                    max_tokens_per_call: max_tokens,
                    max_iterations: Some(max_iterations),
                    token_budget: Some(token_budget),
                    workspace_root: None,
                    auto_approve_override: Some(true),
                    trace_id: None,
                    kind: RunKind::Scheduled,
                    group_id: None,
                    seat_id: None,
                    model: Some(model.to_string()),
                    
                    
                    tool_scope: Some(crate::agent::toolplane::ToolScope::only(
                        crate::agent::permission::SAFE_TOOLS,
                    )),
                    
                    session_kind: crate::agent::permission::SessionKind::UnattendedWorker,
                    
                    resume: None,
                    
                    task_id: Some(task_id.to_string()),
                },
            )
            .await;
        
        let _ = LongTaskRepository::new(&self.db).stamp_job_finished(task_id, &outcome.run_id);
        Ok(format!("已创建会话 {} 并执行任务", session.id))
    }

    
    fn recompute_next(db: &DbConnection, task: &ScheduledTask) {
        let next = task.next_occurrence();
        let _ = TaskRepository::new(db).update_next_run(&task.id, next.as_deref());
    }
}


async fn run_shell(command: &str) -> Result<String, String> {
    let output = TokioCommand::new("sh")
        .arg("-c")
        .arg(command)
        .output()
        .await
        .map_err(|e| format!("执行失败: {}", e))?;
    let out = String::from_utf8_lossy(&output.stdout).to_string();
    let err = String::from_utf8_lossy(&output.stderr).to_string();
    if !output.status.success() {
        return Err(format!(
            "退出码 {}: {}",
            output.status.code().unwrap_or(-1),
            err
        ));
    }
    Ok(if out.is_empty() { err } else { out })
}

fn emit_task_event(
    bus: &Arc<dyn EventBus>,
    task_id: &str,
    success: bool,
    message: &str,
    run_count: i64,
) {
    let payload = serde_json::json!({
        "task_id": task_id,
        "success": success,
        "message": message,
        "run_count": run_count,
        "at": chrono::Utc::now().to_rfc3339(),
    });
    bus.emit(
        "scheduled_task_event",
        "scheduled:task_event",
        None,
        payload,
    );
}

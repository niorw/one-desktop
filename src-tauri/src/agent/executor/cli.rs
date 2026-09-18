






use crate::a2a::model::{A2aTask, A2aTaskState};
use crate::agent::approval::ApprovalDecision;
use crate::agent::executor::{A2aTaskResult, AgentExecutor, ExecutorAvailability};
use crate::agent::ports::{ApprovalGate, EventBus};
use async_trait::async_trait;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::process::Command as TokioCommand;
use tokio::sync::Mutex as TokioMutex;


const CLI_TIMEOUT_SECS: u64 = 600;


pub trait CliAdapter: Send + Sync {
    
    fn name(&self) -> &'static str;
    fn binary(&self) -> &'static str;
    fn version_args(&self) -> &'static [&'static str];
    
    
    
    
    fn auth_probe_args(&self) -> Option<&'static [&'static str]> {
        None
    }
    
    fn build_command(&self, task: &A2aTask) -> Result<Vec<String>, String>;
    
    fn parse_output(&self, stdout: &str) -> String;
}


fn cli_flags(task: &A2aTask) -> Vec<String> {
    task.metadata
        .get("cli_flags")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}







#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CliFailureKind {
    
    Timeout,
    
    Cancelled,
    
    NonZeroExit,
    
    EmptyResponse,
    
    AuthFailure,
    
    ModelUnavailable,
    
    Unknown,
}

impl CliFailureKind {
    
    pub fn label(&self) -> &'static str {
        match self {
            CliFailureKind::Timeout => "timeout",
            CliFailureKind::Cancelled => "cancelled",
            CliFailureKind::NonZeroExit => "non_zero_exit",
            CliFailureKind::EmptyResponse => "empty_response",
            CliFailureKind::AuthFailure => "auth_failure",
            CliFailureKind::ModelUnavailable => "model_unavailable",
            CliFailureKind::Unknown => "unknown",
        }
    }
}


#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CliFlagScreen {
    Allow,
    NeedsApproval(String),
}



pub fn screen_cli_flags(task: &A2aTask) -> CliFlagScreen {
    let Some(flags) = task.metadata.get("cli_flags").and_then(|v| v.as_array()) else {
        return CliFlagScreen::Allow;
    };
    let dangerous: Vec<String> = flags
        .iter()
        .filter_map(|x| x.as_str().map(|s| s.to_string()))
        .filter(|f| f == "--yolo" || f == "-y" || f.contains("yolo"))
        .collect();
    if dangerous.is_empty() {
        CliFlagScreen::Allow
    } else {
        CliFlagScreen::NeedsApproval(serde_json::json!(dangerous).to_string())
    }
}



pub fn classify_cli_failure(output: &Output) -> CliFailureKind {
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).to_lowercase();
        if err.contains("auth")
            || err.contains("401")
            || err.contains("unauthorized")
            || err.contains("api key")
        {
            return CliFailureKind::AuthFailure;
        }
        if err.contains("model")
            && (err.contains("not found")
                || err.contains("unavailable")
                || err.contains("does not exist"))
        {
            return CliFailureKind::ModelUnavailable;
        }
        return CliFailureKind::NonZeroExit;
    }
    CliFailureKind::EmptyResponse
}


pub fn is_cli_session_loss(reason: &str) -> bool {
    let r = reason.to_lowercase();
    r.contains("session")
        || r.contains("resume")
        || r.contains("conversation not found")
        || r.contains("chat not found")
        || r.contains("thread not found")
}


pub fn to_one_shot_task(task: &A2aTask) -> A2aTask {
    let mut t = task.clone();
    for k in ["session_id", "resume", "cli_session", "continue"] {
        t.metadata.remove(k);
    }
    t
}


fn parse_json_text(stdout: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(stdout).ok()?;
    for key in ["result", "message", "output", "text"] {
        if let Some(s) = v.get(key).and_then(|x| x.as_str()) {
            if !s.trim().is_empty() {
                return Some(s.trim().to_string());
            }
        }
    }
    None
}



fn output_has_auth_signal(text: &str) -> bool {
    let t = text.to_lowercase();
    ["401", "403", "unauthorized", "authentication", "api key", "api_key", "login", "not authenticated", "sign in", "auth", "credential"]
        .iter()
        .any(|k| t.contains(k))
}


pub struct CodexAdapter;
impl CliAdapter for CodexAdapter {
    fn name(&self) -> &'static str {
        "cli:codex"
    }
    fn binary(&self) -> &'static str {
        "codex"
    }
    fn version_args(&self) -> &'static [&'static str] {
        &["--version"]
    }
    
    fn auth_probe_args(&self) -> Option<&'static [&'static str]> {
        Some(&["login", "status"])
    }
    fn build_command(&self, task: &A2aTask) -> Result<Vec<String>, String> {
        let prompt = task.task_card_text();
        if prompt.is_empty() {
            return Err("task card is empty".into());
        }
        let mut argv = vec![
            "exec".to_string(),
            "--full-auto".to_string(),
            "--json".to_string(),
        ];
        argv.extend(cli_flags(task));
        argv.push(prompt);
        Ok(argv)
    }
    fn parse_output(&self, stdout: &str) -> String {
        parse_json_text(stdout).unwrap_or_else(|| stdout.trim().to_string())
    }
}


pub struct PiAdapter;
impl CliAdapter for PiAdapter {
    fn name(&self) -> &'static str {
        "cli:pi"
    }
    fn binary(&self) -> &'static str {
        "pi"
    }
    fn version_args(&self) -> &'static [&'static str] {
        &["--version"]
    }
    fn build_command(&self, task: &A2aTask) -> Result<Vec<String>, String> {
        let prompt = task.task_card_text();
        if prompt.is_empty() {
            return Err("task card is empty".into());
        }
        let mut argv = vec!["-p".to_string()];
        argv.extend(cli_flags(task));
        argv.push(prompt);
        Ok(argv)
    }
    fn parse_output(&self, stdout: &str) -> String {
        parse_json_text(stdout).unwrap_or_else(|| stdout.trim().to_string())
    }
}


pub struct OpenCodeAdapter;
impl CliAdapter for OpenCodeAdapter {
    fn name(&self) -> &'static str {
        "cli:opencode"
    }
    fn binary(&self) -> &'static str {
        "opencode"
    }
    fn version_args(&self) -> &'static [&'static str] {
        &["--version"]
    }
    fn build_command(&self, task: &A2aTask) -> Result<Vec<String>, String> {
        let prompt = task.task_card_text();
        if prompt.is_empty() {
            return Err("task card is empty".into());
        }
        let mut argv = vec!["run".to_string()];
        argv.extend(cli_flags(task));
        argv.push(prompt);
        Ok(argv)
    }
    fn parse_output(&self, stdout: &str) -> String {
        stdout.trim().to_string()
    }
}


pub struct ClaudeAdapter;
impl CliAdapter for ClaudeAdapter {
    fn name(&self) -> &'static str {
        "cli:claude"
    }
    fn binary(&self) -> &'static str {
        "claude"
    }
    fn version_args(&self) -> &'static [&'static str] {
        &["--version"]
    }
    fn build_command(&self, task: &A2aTask) -> Result<Vec<String>, String> {
        let prompt = task.task_card_text();
        if prompt.is_empty() {
            return Err("task card is empty".into());
        }
        let mut argv = vec!["-p".to_string()];
        argv.extend(cli_flags(task));
        argv.push(prompt);
        Ok(argv)
    }
    fn parse_output(&self, stdout: &str) -> String {
        stdout.trim().to_string()
    }
}





pub fn default_cli_executors(
    approval: Option<Arc<dyn ApprovalGate>>,
    bus: Option<Arc<dyn EventBus>>,
) -> HashMap<String, Arc<dyn AgentExecutor>> {
    let mut map: HashMap<String, Arc<dyn AgentExecutor>> = HashMap::new();
    let adapters: Vec<Arc<dyn CliAdapter>> = vec![
        Arc::new(CodexAdapter),
        Arc::new(PiAdapter),
        Arc::new(OpenCodeAdapter),
        Arc::new(ClaudeAdapter),
    ];
    for a in adapters {
        map.insert(
            a.name().to_string(),
            Arc::new(CliExecutor::new(a, approval.clone(), bus.clone())),
        );
    }
    map
}


async fn wait_for_cancel(flag: Arc<AtomicBool>) {
    while !flag.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}


pub struct CliExecutor {
    adapter: Arc<dyn CliAdapter>,
    
    running: Arc<TokioMutex<HashMap<String, Arc<AtomicBool>>>>,
    
    approval: Option<Arc<dyn ApprovalGate>>,
    
    bus: Option<Arc<dyn EventBus>>,
}

impl CliExecutor {
    pub fn new(
        adapter: Arc<dyn CliAdapter>,
        approval: Option<Arc<dyn ApprovalGate>>,
        bus: Option<Arc<dyn EventBus>>,
    ) -> Self {
        Self {
            adapter,
            running: Arc::new(TokioMutex::new(HashMap::new())),
            approval,
            bus,
        }
    }

    pub fn name(&self) -> &'static str {
        self.adapter.name()
    }

    
    
    
    pub async fn probe_detail(&self) -> ExecutorAvailability {
        use std::io::ErrorKind;
        let version_ok = match TokioCommand::new(self.adapter.binary())
            .args(self.adapter.version_args())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
        {
            Ok(s) => s.success(),
            Err(e) if e.kind() == ErrorKind::NotFound => return ExecutorAvailability::NotFound,
            Err(_) => return ExecutorAvailability::LaunchFailed,
        };
        if !version_ok {
            return ExecutorAvailability::LaunchFailed;
        }
        
        let Some(probe) = self.adapter.auth_probe_args() else {
            return ExecutorAvailability::Available;
        };
        match TokioCommand::new(self.adapter.binary())
            .args(probe)
            .output()
            .await
        {
            Ok(out) if out.status.success() => ExecutorAvailability::Available,
            
            Ok(out) => {
                let text = format!(
                    "{}{}",
                    String::from_utf8_lossy(&out.stderr),
                    String::from_utf8_lossy(&out.stdout)
                );
                if output_has_auth_signal(&text) {
                    ExecutorAvailability::AuthMissing
                } else {
                    ExecutorAvailability::LaunchFailed
                }
            }
            Err(_) => ExecutorAvailability::LaunchFailed,
        }
    }

    
    
    pub async fn probe(&self) -> bool {
        self.probe_detail().await == ExecutorAvailability::Available
    }
}

#[async_trait]
impl AgentExecutor for CliExecutor {
    async fn run(&self, task: A2aTask) -> Result<A2aTaskResult, String> {
        
        match screen_cli_flags(&task) {
            CliFlagScreen::Allow => {}
            CliFlagScreen::NeedsApproval(flags) => match &self.approval {
                None => {
                    tracing::error!(
                        target: "onedesktop.cli",
                        executor = self.adapter.name(),
                        flags = %flags,
                        "dangerous cli flag but no approval gate configured"
                    );
                    return Err(format!(
                        "dangerous cli flag requires approval but no approval gate is configured: {}",
                        flags
                    ))
                }
                Some(gate) => {
                    let decision = gate
                        .request_cli_approval(self.adapter.name(), &flags, &task.context_id)
                        .await
                        .map_err(|e| format!("cli approval request failed: {}", e))?;
                    if decision != ApprovalDecision::Accept {
                        tracing::warn!(
                            target: "onedesktop.cli",
                            executor = self.adapter.name(),
                            flags = %flags,
                            decision = ?decision,
                            "cli flag approval denied"
                        );
                        return Err(format!("cli flag approval denied ({:?})", decision));
                    }
                    if let Some(bus) = &self.bus {
                        let _ = bus.emit(
                            "agent-event",
                            "agent:approval_request",
                            Some(&task.context_id),
                            serde_json::json!({
                                "tool": self.adapter.name(),
                                "args": flags,
                                "session_id": task.context_id,
                                "source": "cli_executor",
                            }),
                        );
                    }
                }
            },
        }
        if !self.probe().await {
            tracing::warn!(
                target: "onedesktop.cli",
                executor = self.adapter.name(),
                binary = self.adapter.binary(),
                "CLI not found on machine — task will fail"
            );
            return Err(format!(
                "CLI '{}' not found on this machine (executor {})",
                self.adapter.binary(),
                self.adapter.name()
            ));
        }
        
        let res = self.execute(task.clone()).await;
        if let Err(ref e) = res {
            if task.metadata.contains_key("session_id") && is_cli_session_loss(e) {
                tracing::info!(
                    target: "onedesktop.cli",
                    executor = self.adapter.name(),
                    error = %e,
                    "cli session lost — retrying one-shot (F11 session fallback)"
                );
                return self.execute(to_one_shot_task(&task)).await;
            }
        }
        res
    }

    async fn cancel(&self, task_id: &str) {
        if let Some(flag) = self.running.lock().await.get(task_id).cloned() {
            flag.store(true, Ordering::SeqCst);
        }
    }

    async fn probe_available(&self) -> ExecutorAvailability {
        self.probe_detail().await
    }
}



impl CliExecutor {
    async fn execute(&self, task: A2aTask) -> Result<A2aTaskResult, String> {
        let argv = self.adapter.build_command(&task)?;
        let cwd = task
            .metadata
            .get("workspace_root")
            .and_then(|v| v.as_str())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));

        let child = TokioCommand::new(self.adapter.binary())
            .args(&argv)
            .current_dir(cwd)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true) 
            .spawn()
            .map_err(|e| format!("failed to spawn {}: {}", self.adapter.binary(), e))?;

        let cancel_flag = Arc::new(AtomicBool::new(false));
        {
            let mut running = self.running.lock().await;
            running.insert(task.task_id.clone(), cancel_flag.clone());
        }

        let wait = child.wait_with_output();
        let outcome = tokio::select! {
            out = wait => out.map_err(|e| format!("CLI wait failed: {}", e)),
            _ = tokio::time::sleep(Duration::from_secs(CLI_TIMEOUT_SECS)) => Err(format!(
                "CLI '{}' timed out after {}s and was killed",
                self.adapter.binary(),
                CLI_TIMEOUT_SECS
            )),
            _ = wait_for_cancel(cancel_flag) => {
                Err(format!("CLI '{}' cancelled", self.adapter.binary()))
            }
        };

        {
            let mut running = self.running.lock().await;
            running.remove(&task.task_id);
        }
        let output = match outcome {
            Ok(o) => o,
            Err(reason) => {
                
                let kind = if reason.contains("timed out") {
                    CliFailureKind::Timeout
                } else if reason.contains("cancelled") {
                    CliFailureKind::Cancelled
                } else {
                    CliFailureKind::Unknown
                };
                return Err(format!("[cli:{}] {}", kind.label(), reason));
            }
        };

        let stdout = String::from_utf8_lossy(&output.stdout);
        let text = self.adapter.parse_output(&stdout);
        
        let (status, failure_kind) = if text.is_empty() {
            let k = classify_cli_failure(&output);
            (A2aTaskState::Failed, Some(k.label().to_string()))
        } else {
            (A2aTaskState::Completed, None)
        };
        Ok(A2aTaskResult {
            task_id: task.task_id,
            final_text: text,
            status,
            total_tokens: 0,
            failure_kind,
            written_files: vec![], 
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::a2a::model::{A2aMessage, A2aPart};
    use std::os::unix::process::ExitStatusExt;

    fn task_with_flags(flags: Option<Vec<&str>>) -> A2aTask {
        let mut meta = std::collections::BTreeMap::new();
        meta.insert("workspace_root".into(), serde_json::json!("/tmp/ws"));
        if let Some(fs) = flags {
            meta.insert(
                "cli_flags".into(),
                serde_json::json!(fs.iter().map(|s| s.to_string()).collect::<Vec<_>>()),
            );
        }
        A2aTask {
            task_id: "t1".into(),
            context_id: "g:w".into(),
            status: A2aTaskState::Working,
            messages: vec![A2aMessage {
                message_id: "m1".into(),
                context_id: "g:w".into(),
                task_id: Some("t1".into()),
                role: "user".into(),
                parts: vec![A2aPart::text("调研竞品定价并输出报告")],
                reference_task_ids: vec![],
            }],
            artifacts: vec![],
            metadata: meta,
        }
    }

    #[test]
    fn codex_command_is_whitelisted_and_structured() {
        let t = task_with_flags(Some(vec!["--skip-git-repo-check"]));
        let argv = CodexAdapter.build_command(&t).unwrap();
        assert_eq!(argv[0], "exec");
        assert!(argv.contains(&"--json".to_string()));
        assert!(argv.contains(&"--skip-git-repo-check".to_string()));
        assert!(argv.contains(&"调研竞品定价并输出报告".to_string()));
    }

    #[test]
    fn dangerous_flag_screened_for_approval() {
        
        let t = task_with_flags(Some(vec!["--yolo"]));
        assert!(CodexAdapter.build_command(&t).is_ok());
        
        assert_eq!(screen_cli_flags(&t), CliFlagScreen::NeedsApproval("[\"--yolo\"]".into()));
        
        assert_eq!(screen_cli_flags(&task_with_flags(Some(vec!["--skip-git-repo-check"]))), CliFlagScreen::Allow);
        assert_eq!(screen_cli_flags(&task_with_flags(None)), CliFlagScreen::Allow);
    }

    #[test]
    fn pi_command_single_shot() {
        let t = task_with_flags(None);
        let argv = PiAdapter.build_command(&t).unwrap();
        assert_eq!(argv[0], "-p");
        assert_eq!(argv[1], "调研竞品定价并输出报告");
    }

    #[test]
    fn codex_json_output_parsed() {
        let out = r#"{"result": "已完成调研"}"#;
        assert_eq!(CodexAdapter.parse_output(out), "已完成调研");
        
        assert_eq!(PiAdapter.parse_output(" 普通文本输出 "), "普通文本输出");
    }

    #[test]
    fn empty_task_card_rejected() {
        let t = A2aTask {
            task_id: "t1".into(),
            context_id: "g:w".into(),
            status: A2aTaskState::Working,
            messages: vec![],
            artifacts: vec![],
            metadata: Default::default(),
        };
        assert!(CodexAdapter.build_command(&t).is_err());
    }

    

    fn task_with_session() -> A2aTask {
        let mut t = task_with_flags(None);
        t.metadata.insert("session_id".into(), serde_json::json!("sess-abc"));
        t
    }

    #[test]
    fn classify_cli_failure_enumerates_reasons() {
        use std::process::{ExitStatus, Output};
        let success = Output {
            status: ExitStatus::from_raw(0),
            stdout: b"done".to_vec(),
            stderr: vec![],
        };
        
        assert_eq!(classify_cli_failure(&success), CliFailureKind::EmptyResponse);

        let auth_err = Output {
            status: ExitStatus::from_raw(1),
            stdout: vec![],
            stderr: b"error: 401 unauthorized, check your api key".to_vec(),
        };
        assert_eq!(classify_cli_failure(&auth_err), CliFailureKind::AuthFailure);

        let model_err = Output {
            status: ExitStatus::from_raw(1),
            stdout: vec![],
            stderr: b"model gpt-99 not found or unavailable".to_vec(),
        };
        assert_eq!(classify_cli_failure(&model_err), CliFailureKind::ModelUnavailable);

        let boom = Output {
            status: ExitStatus::from_raw(2),
            stdout: vec![],
            stderr: b"panic: index out of bounds".to_vec(),
        };
        assert_eq!(classify_cli_failure(&boom), CliFailureKind::NonZeroExit);
    }

    #[test]
    fn session_loss_detection_and_one_shot_fallback() {
        assert!(is_cli_session_loss("conversation not found, please start a new session"));
        assert!(is_cli_session_loss("resume target session expired"));
        assert!(!is_cli_session_loss("timed out after 600s"));
        assert!(!is_cli_session_loss("non-zero exit 2"));

        let t = task_with_session();
        assert!(t.metadata.contains_key("session_id"));
        let one_shot = to_one_shot_task(&t);
        assert!(!one_shot.metadata.contains_key("session_id"));
    }

    #[test]
    fn auth_signal_detection_and_adapter_probe_config() {
        
        assert!(output_has_auth_signal("error: 401 unauthorized"));
        assert!(output_has_auth_signal("please login to continue"));
        assert!(output_has_auth_signal("invalid api_key provided"));
        assert!(output_has_auth_signal("Authentication failed: credential expired"));
        assert!(!output_has_auth_signal("command not found"));
        assert!(!output_has_auth_signal("version 0.1.0"));

        
        assert_eq!(
            CodexAdapter.auth_probe_args(),
            Some(&["login", "status"][..])
        );
        assert_eq!(PiAdapter.auth_probe_args(), None);
        assert_eq!(OpenCodeAdapter.auth_probe_args(), None);
        assert_eq!(ClaudeAdapter.auth_probe_args(), None);
    }

    
    struct MockApprovalGate {
        decision: ApprovalDecision,
    }
    #[async_trait]
    impl crate::agent::ports::ApprovalGate for MockApprovalGate {
        async fn request_cli_approval(
            &self,
            _tool: &str,
            _args: &str,
            _session_id: &str,
        ) -> Result<ApprovalDecision, String> {
            Ok(self.decision.clone())
        }
    }

    #[tokio::test]
    async fn approval_bridge_gates_dangerous_flag() {
        use std::sync::Arc;

        let danger = task_with_flags(Some(vec!["--yolo"]));

        
        let exec_none = CliExecutor::new(Arc::new(CodexAdapter), None, None);
        let r_none = exec_none.run(danger.clone()).await;
        assert!(r_none.is_err());
        assert!(r_none.unwrap_err().contains("no approval gate"));

        
        let exec_deny = CliExecutor::new(
            Arc::new(CodexAdapter),
            Some(Arc::new(MockApprovalGate { decision: ApprovalDecision::Ignore })),
            None,
        );
        let r_deny = exec_deny.run(danger.clone()).await;
        assert!(r_deny.is_err());
        assert!(r_deny.unwrap_err().contains("approval denied"));

        
        let exec_accept = CliExecutor::new(
            Arc::new(CodexAdapter),
            Some(Arc::new(MockApprovalGate { decision: ApprovalDecision::Accept })),
            None,
        );
        let r_accept = exec_accept.run(danger.clone()).await;
        assert!(r_accept.is_err());
        let msg = r_accept.unwrap_err();
        assert!(!msg.contains("no approval gate"), "审批已通过却被当成无 gate 拒绝");
        assert!(!msg.contains("approval denied"), "审批已接受却报拒绝");
    }
}

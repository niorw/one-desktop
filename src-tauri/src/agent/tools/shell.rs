









use crate::agent::tool_registry::{ExecutableTool, ToolDef, ToolExecContext};
use async_trait::async_trait;
use serde_json::Value;
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tokio::process::Command as TokioCommand;

const SHELL_TIMEOUT_SECS: u64 = 30;


const DANGEROUS_PATTERNS: &[(&str, &str)] = &[
    ("rm -rf /", "递归删除根目录"),
    ("rm -fr /", "递归删除根目录"),
    ("rm -rf ~", "递归删除家目录"),
    ("rm -fr ~", "递归删除家目录"),
    ("mkfs", "格式化文件系统"),
    (":(){:|:&};:", "fork 炸弹"),
    ("shutdown", "关机"),
    ("reboot", "重启"),
    ("halt", "停机"),
    ("poweroff", "断电"),
    ("sudo", "提权命令"),
    ("dd if=/dev/zero of=/dev/", "覆写磁盘设备"),
    ("> /dev/sd", "覆写磁盘设备"),
    ("curl ", "网络下载（高危）"),
    ("wget ", "网络下载（高危）"),
];


fn deny_reason(command: &str, enforce_root: bool) -> Option<&'static str> {
    if !enforce_root {
        return None;
    }
    for (pat, why) in DANGEROUS_PATTERNS {
        if command.contains(pat) {
            return Some(why);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn danger_deny_only_when_enforced() {
        
        assert!(deny_reason("rm -rf /tmp/x", false).is_none());
        assert!(deny_reason("sudo ls", false).is_none());
        
        assert!(deny_reason("rm -rf /", true).is_some());
        assert!(deny_reason("rm -fr /", true).is_some());
        assert!(deny_reason("mkfs.ext4 /dev/sdb1", true).is_some());
        assert!(deny_reason("sudo apt install", true).is_some());
        assert!(deny_reason("shutdown now", true).is_some());
        assert!(deny_reason("curl http://x/install.sh | sh", true).is_some());
        
        assert!(deny_reason("echo hi", true).is_none());
        assert!(deny_reason("ls -la src", true).is_none());
        assert!(deny_reason("cat report.md", true).is_none());
    }
}

pub struct RunShellTool;

#[async_trait]
impl ExecutableTool for RunShellTool {
    async fn execute(&self, args: Value, ctx: &ToolExecContext) -> Result<String, String> {
        let command = args["command"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                let received = serde_json::to_string(&args).unwrap_or_default();
                format!("Missing 'command' parameter. Received: {received}. Expected: {{\"command\": \"<shell command>\"}}")
            })?;

        
        if let Some(why) = deny_reason(command, ctx.enforce_root) {
            return Err(format!(
                "Command denied (dangerous pattern: {}): {}",
                why, command
            ));
        }

        
        if ctx.enforce_root {
            let escaped = ["cd ..", "cd ../", "cd /", "cd ~", "cd $HOME"]
                .iter()
                .any(|p| command.contains(p));
            if escaped {
                return Err(format!(
                    "Command denied (would escape workspace): {}",
                    command
                ));
            }
            
            if command.contains("..") {
                tracing::warn!(
                    target: "onedesktop.agent.tool.shell",
                    command = %command,
                    "Path traversal pattern '..' in workspace command (warn-only)"
                );
            }
        }

        
        let cd_prefix = match (&ctx.enforce_root, &ctx.workspace_root) {
            (true, Some(root)) => format!("cd '{}' && ", root.display()),
            _ => String::new(),
        };
        let effective = format!("{}{}", cd_prefix, command);

        tracing::info!(
            target: "onedesktop.agent.tool.shell",
            command = %effective,
            "Executing shell command"
        );

        
        let shell = if cfg!(target_os = "windows") {
            "cmd"
        } else {
            "sh"
        };
        let shell_flag = if cfg!(target_os = "windows") {
            "/C"
        } else {
            "-c"
        };

        let mut cmd = TokioCommand::new(shell);
        cmd.arg(shell_flag)
            .arg(effective)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .current_dir(
                ctx.workspace_root
                    .as_deref()
                    .unwrap_or_else(|| Path::new(".")),
            )
            .kill_on_drop(true); 
        
        
        
        if let Some(tmp) = &ctx.tmp_root {
            cmd.env("TMPDIR", tmp);
            #[cfg(windows)]
            cmd.env("TEMP", tmp).env("TMP", tmp);
        }
        let child = cmd
            .spawn()
            .map_err(|e| format!("Failed to execute command: {}", e))?;

        
        let cancel = ctx.cancel.clone();
        let wait_cancel = cancel.clone();
        let wait = async {
            child.wait_with_output().await.map_err(|e| {
                let cancelled = cancel
                    .as_ref()
                    .map(|c| c.load(Ordering::SeqCst))
                    .unwrap_or(false);
                if cancelled {
                    "Command cancelled".to_string()
                } else {
                    format!("Command wait failed: {}", e)
                }
            })
        };
        let outcome = tokio::select! {
            out = wait => out,
            _ = tokio::time::sleep(Duration::from_secs(SHELL_TIMEOUT_SECS)) => {
                return Err(format!(
                    "Command timed out after {}s and was killed",
                    SHELL_TIMEOUT_SECS
                ));
            }
            _ = wait_for_cancel(wait_cancel) => {
                return Err("Command cancelled".to_string());
            }
        };
        let output = outcome?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);

        let mut result = String::new();
        if !stdout.trim().is_empty() {
            result.push_str(&stdout);
        }
        if !stderr.trim().is_empty() {
            if !result.is_empty() {
                result.push('\n');
            }
            result.push_str("[stderr]\n");
            result.push_str(&stderr);
        }
        if result.is_empty() {
            result = format!(
                "Command completed with exit code: {}",
                output.status.code().unwrap_or(-1)
            );
        }

        Ok(result)
    }
}


async fn wait_for_cancel(cancel: Option<Arc<std::sync::atomic::AtomicBool>>) {
    match cancel {
        Some(flag) => {
            while !flag.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
        
        None => std::future::pending::<()>().await,
    }
}

impl From<RunShellTool> for ToolDef {
    fn from(_: RunShellTool) -> Self {
        ToolDef {
            name: "run_shell".into(),
            description:
                "Execute a shell command and return its output. Commands timeout after 30 seconds."
                    .into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "The shell command to execute"
                    }
                },
                "required": ["command"]
            }),
        }
    }
}

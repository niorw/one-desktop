








use crate::agent::tool_registry::{ToolDef, ToolExecContext};
use crate::agent::toolplane::{ToolOrigin, ToolOutcome, ToolProvider, UnavailableReason};
use crate::mcp::model::McpServer;
use crate::mcp::session::{McpError, McpSession};
use async_trait::async_trait;
use serde_json::Value;
use std::sync::Arc;
use std::time::Instant;


pub struct McpToolProvider {
    server: McpServer,
    session: Arc<McpSession>,
}

impl McpToolProvider {
    pub fn new(server: McpServer) -> Self {
        let session = Arc::new(McpSession::new(server.clone()));
        Self { server, session }
    }

    
    fn prefix(&self) -> String {
        format!("mcp__{}__", self.server.id)
    }

    
    fn strip_prefix<'a>(&self, full_name: &'a str) -> &'a str {
        full_name
            .strip_prefix(&self.prefix())
            .unwrap_or(full_name)
    }
}

#[async_trait]
impl ToolProvider for McpToolProvider {
    fn origin(&self) -> ToolOrigin {
        ToolOrigin::Mcp(self.server.id.clone())
    }

    async fn list(&self) -> Result<Vec<ToolDef>, String> {
        let s = self.session.clone();
        let prefix = self.prefix();
        let defs = tokio::task::spawn_blocking(move || s.list_tools())
            .await
            .map_err(|e| format!("MCP list 任务失败: {}", e))?
            .map_err(|e| format!("MCP tools/list 失败: {}", e))?;
        Ok(defs
            .into_iter()
            .map(|mut d| {
                d.name = format!("{}{}", prefix, d.name);
                d
            })
            .collect())
    }

    async fn invoke(&self, name: &str, args: Value, _ctx: &ToolExecContext) -> ToolOutcome {
        let tool = self.strip_prefix(name).to_string();
        let s = self.session.clone();
        let start = Instant::now();
        
        let tool_name = tool.clone();
        let res = tokio::task::spawn_blocking(move || s.call_tool(&tool, args))
            .await
            .map_err(|e| McpError::Network(format!("MCP 调用任务失败: {}", e)));
        match res {
            Ok(Ok(v)) => ToolOutcome::Ok {
                content: v.to_string(),
                ms: start.elapsed().as_millis() as u64,
            },
            Ok(Err(err)) => {
                tracing::warn!(
                    target: "onedesktop.mcp",
                    tool = %tool_name,
                    error = ?err,
                    dur_ms = start.elapsed().as_millis() as u64,
                    "MCP tool invoke failed"
                );
                map_error(err)
            }
            Err(err) => {
                tracing::warn!(
                    target: "onedesktop.mcp",
                    tool = %tool_name,
                    error = ?err,
                    "MCP tool invoke task panicked/failed"
                );
                map_error(err)
            }
        }
    }

    async fn health(&self) -> bool {
        let s = self.session.clone();
        tokio::task::spawn_blocking(move || {
            
            s.list_tools().is_ok()
        })
        .await
        .unwrap_or(false)
    }
}


fn map_error(err: McpError) -> ToolOutcome {
    match err {
        McpError::Network(msg) => ToolOutcome::Unavailable {
            reason: UnavailableReason::Network(msg),
        },
        McpError::Timeout => ToolOutcome::Unavailable {
            reason: UnavailableReason::Timeout,
        },
        McpError::ProcessDown(msg) => ToolOutcome::Unavailable {
            reason: UnavailableReason::ProviderDown(msg),
        },
        McpError::Server(msg) => ToolOutcome::Failed {
            message: msg,
            retryable: true,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::toolplane::{ToolOrigin, ToolProvider};
    use crate::mcp::model::{McpStatus, McpTransport};
    use serde_json::json;
    use std::collections::HashMap;
    use std::fs;

    const FAKE_SERVER: &str = r#"
import sys, json
for line in sys.stdin:
    msg = json.loads(line)
    m = msg.get("method")
    if m == "notifications/initialized":
        continue
    if m == "initialize":
        out = {"jsonrpc":"2.0","id":msg["id"],"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"fake","version":"1.0"}}}
    elif m == "tools/list":
        out = {"jsonrpc":"2.0","id":msg["id"],"result":{"tools":[
            {"name":"echo","description":"echo text back","inputSchema":{"type":"object","properties":{"text":{"type":"string"}}}}
        ]}}
    elif m == "tools/call":
        args = msg["params"].get("arguments", {})
        text = args.get("text","")
        out = {"jsonrpc":"2.0","id":msg["id"],"result":{"content":[{"type":"text","text":"echo:"+text}]}}
    else:
        continue
    sys.stdout.write(json.dumps(out)+"\n")
    sys.stdout.flush()
"#;

    fn provider() -> (McpToolProvider, std::path::PathBuf) {
        
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let script = std::env::temp_dir().join(format!(
            "od_mcp_tp_{}_{}.py",
            std::process::id(),
            seq
        ));
        fs::write(&script, FAKE_SERVER).unwrap();
        let mut env = HashMap::new();
        env.insert("PYTHONUNBUFFERED".to_string(), "1".to_string());
        let server = McpServer {
            id: "ut_fake".to_string(),
            name: "fake".to_string(),
            transport: McpTransport::Stdio,
            command: Some("python3".to_string()),
            args: vec![script.display().to_string()],
            env,
            url: None,
            enabled: true,
            status: McpStatus::Enabled,
            capabilities: Default::default(),
            error: None,
            created_at: String::new(),
            updated_at: String::new(),
        };
        (McpToolProvider::new(server), script)
    }

    #[tokio::test]
    async fn list_prefixes_names() {
        let (p, script) = provider();
        let defs = p.list().await.expect("list should succeed");
        assert_eq!(defs.len(), 1);
        assert_eq!(defs[0].name, "mcp__ut_fake__echo");
        assert_eq!(p.origin(), ToolOrigin::Mcp("ut_fake".to_string()));
        p.session.shutdown();
        let _ = fs::remove_file(script);
    }

    #[tokio::test]
    async fn invoke_ok_content() {
        let (p, script) = provider();
        let out = p
            .invoke("mcp__ut_fake__echo", json!({ "text": "hello" }), &ToolExecContext::default())
            .await;
        match out {
            ToolOutcome::Ok { content, .. } => assert!(content.contains("echo:hello")),
            other => panic!("expected Ok, got {:?}", other),
        }
        p.session.shutdown();
        let _ = fs::remove_file(script);
    }
}


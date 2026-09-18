
















use crate::agent::tool_registry::ToolDef;
use crate::mcp::model::{McpServer, McpTransport};
use crate::paths;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::sync::Mutex;
use std::time::{Duration, Instant};


const IDLE_RECYCLE_MS: u64 = 300_000;

const RPC_TIMEOUT: Duration = Duration::from_secs(15);

const PROTOCOL_VERSION: &str = "2024-11-05";


#[derive(Debug, Clone, PartialEq, Eq)]
pub enum McpError {
    
    Network(String),
    
    Timeout,
    
    ProcessDown(String),
    
    Server(String),
}

impl std::fmt::Display for McpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            McpError::Network(m) => write!(f, "网络错误: {}", m),
            McpError::Timeout => write!(f, "MCP 调用超时"),
            McpError::ProcessDown(m) => write!(f, "MCP 进程不可用: {}", m),
            McpError::Server(m) => write!(f, "MCP 服务器错误: {}", m),
        }
    }
}

struct Inner {
    child: Child,
    stdin: ChildStdin,
    rx: Receiver<Value>,
    next_id: u64,
    last_used: Instant,
}



pub struct McpSession {
    server: McpServer,
    
    
    cwd: Option<PathBuf>,
    inner: Mutex<Option<Inner>>,
}

impl McpSession {
    pub fn new(server: McpServer) -> Self {
        let cwd = if server.id.is_empty() {
            None
        } else {
            Some(paths::mcp_server_dir(&server.id))
        };
        Self::with_cwd(server, cwd)
    }

    pub fn with_cwd(server: McpServer, cwd: Option<PathBuf>) -> Self {
        Self {
            server,
            cwd,
            inner: Mutex::new(None),
        }
    }

    
    fn ensure_alive(&self, inner: &mut Option<Inner>) -> Result<(), McpError> {
        
        if let Some(i) = inner.as_ref() {
            if i.last_used.elapsed().as_millis() as u64 > IDLE_RECYCLE_MS {
                let mut old = inner.take();
                if let Some(mut o) = old.take() {
                    let _ = o.child.kill();
                    let _ = o.child.wait();
                }
            }
        }
        if inner.is_some() {
            
            if let Some(i) = inner.as_mut() {
                match i.child.try_wait() {
                    Ok(Some(status)) => {
                        *inner = None;
                        return Err(McpError::ProcessDown(format!(
                            "MCP server '{}' exited with {}",
                            self.server.name, status
                        )));
                    }
                    Ok(None) => return Ok(()),
                    Err(e) => return Err(McpError::Network(e.to_string())),
                }
            }
        }
        
        let spawned = self.spawn_and_handshake()?;
        *inner = Some(spawned);
        Ok(())
    }

    fn spawn_and_handshake(&self) -> Result<Inner, McpError> {
        if self.server.transport != McpTransport::Stdio {
            return Err(McpError::Network(format!(
                "McpSession 仅支持 stdio 传输（当前 {:?}）",
                self.server.transport
            )));
        }
        let command = self
            .server
            .command
            .clone()
            .ok_or_else(|| McpError::Network("MCP server 缺少 command".to_string()))?;
        let mut cmd = Command::new(&command);
        cmd.args(&self.server.args)
            .envs(&self.server.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if let Some(cwd) = &self.cwd {
            let _ = std::fs::create_dir_all(cwd);
            cmd.current_dir(cwd);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| McpError::Network(format!("无法启动进程 {}: {}", command, e)))?;
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| McpError::Network("无法打开子进程 stdin".to_string()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| McpError::Network("无法打开子进程 stdout".to_string()))?;

        
        
        let (tx, rx) = mpsc::sync_channel::<Value>(64);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
                            if tx.send(v).is_err() {
                                break;
                            }
                        }
                    }
                }
            }
        });

        
        let init = json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": "OneDesktop", "version": "1.0.0" }
        });
        rpc_request(&mut stdin, &rx, 1, "initialize", init)?;
        
        let note = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        stdin
            .write_all(format!("{}\n", note).as_bytes())
            .map_err(|e| McpError::Network(e.to_string()))?;
        stdin.flush().map_err(|e| McpError::Network(e.to_string()))?;

        Ok(Inner {
            child,
            stdin,
            rx,
            next_id: 2,
            last_used: Instant::now(),
        })
    }

    
    pub fn list_tools(&self) -> Result<Vec<ToolDef>, McpError> {
        let mut guard = self.inner.lock().expect("mcp session mutex poisoned");
        self.ensure_alive(&mut guard)?;
        let Inner {
            stdin,
            rx,
            next_id,
            last_used,
            ..
        } = guard.as_mut().expect("alive after ensure");
        let id = *next_id;
        *next_id += 1;
        let res = rpc_request(stdin, rx, id, "tools/list", json!({}))?;
        let mut defs = Vec::new();
        if let Some(arr) = res
            .get("result")
            .and_then(|r| r.get("tools"))
            .and_then(|v| v.as_array())
        {
            for item in arr {
                let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("");
                if name.is_empty() {
                    continue;
                }
                let description = item
                    .get("description")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let parameters = item.get("inputSchema").cloned().unwrap_or(json!({}));
                defs.push(ToolDef {
                    name: name.to_string(),
                    description,
                    parameters,
                });
            }
        }
        *last_used = Instant::now();
        Ok(defs)
    }

    
    pub fn call_tool(&self, tool: &str, arguments: Value) -> Result<Value, McpError> {
        let mut guard = self.inner.lock().expect("mcp session mutex poisoned");
        self.ensure_alive(&mut guard)?;
        let Inner {
            stdin,
            rx,
            next_id,
            last_used,
            ..
        } = guard.as_mut().expect("alive after ensure");
        let id = *next_id;
        *next_id += 1;
        let params = json!({ "name": tool, "arguments": arguments });
        let res = rpc_request(stdin, rx, id, "tools/call", params)?;
        *last_used = Instant::now();
        res.get("result")
            .cloned()
            .ok_or_else(|| McpError::Server("tools/call 无 result".to_string()))
    }

    
    pub fn shutdown(&self) {
        let mut guard = self.inner.lock().expect("mcp session mutex poisoned");
        if let Some(mut i) = guard.take() {
            let _ = i.child.kill();
            let _ = i.child.wait();
        }
    }
}

impl Drop for McpSession {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.inner.lock() {
            if let Some(mut i) = guard.take() {
                let _ = i.child.kill();
                let _ = i.child.wait();
            }
        }
    }
}



fn rpc_request(
    stdin: &mut ChildStdin,
    rx: &Receiver<Value>,
    id: u64,
    method: &str,
    params: Value,
) -> Result<Value, McpError> {
    let req = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
    let bytes = format!("{}\n", req);
    stdin
        .write_all(bytes.as_bytes())
        .map_err(|e| McpError::Network(e.to_string()))?;
    stdin
        .flush()
        .map_err(|e| McpError::Network(e.to_string()))?;
    loop {
        let msg = rx
            .recv_timeout(RPC_TIMEOUT)
            .map_err(|_| McpError::Timeout)?;
        let msg_id = msg.get("id").and_then(|v| v.as_u64());
        if msg_id == Some(id) {
            if let Some(err) = msg.get("error") {
                return Err(McpError::Server(format!("MCP 错误: {}", err)));
            }
            return Ok(msg);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::model::McpTransport;
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
        name = msg["params"].get("name","")
        if name != "echo":
            out = {"jsonrpc":"2.0","id":msg["id"],"error":{"code":-32602,"message":"Unknown tool: "+name}}
        else:
            args = msg["params"].get("arguments", {})
            text = args.get("text","")
            out = {"jsonrpc":"2.0","id":msg["id"],"result":{"content":[{"type":"text","text":"echo:"+text}]}}
    else:
        continue
    sys.stdout.write(json.dumps(out)+"\n")
    sys.stdout.flush()
"#;

    fn fake_server() -> (McpSession, PathBuf) {
        
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let script = std::env::temp_dir().join(format!(
            "od_mcp_fake_{}_{}.py",
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
            status: crate::mcp::model::McpStatus::Enabled,
            capabilities: Default::default(),
            error: None,
            created_at: String::new(),
            updated_at: String::new(),
        };
        let session = McpSession::with_cwd(server, None);
        (session, script)
    }

    #[test]
    fn tools_list_round_trip() {
        let (session, script) = fake_server();
        let defs = session.list_tools().expect("list_tools should succeed");
        assert_eq!(defs.len(), 1);
        assert_eq!(defs[0].name, "echo");
        assert_eq!(defs[0].description, "echo text back");
        session.shutdown();
        let _ = fs::remove_file(script);
    }

    #[test]
    fn tools_call_round_trip() {
        let (session, script) = fake_server();
        let res = session
            .call_tool("echo", json!({ "text": "hello" }))
            .expect("call_tool should succeed");
        
        let text = res
            .get("content")
            .and_then(|c| c.as_array())
            .and_then(|a| a.first())
            .and_then(|i| i.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("");
        assert_eq!(text, "echo:hello");
        session.shutdown();
        let _ = fs::remove_file(script);
    }

    #[test]
    fn unknown_tool_returns_server_error() {
        let (session, script) = fake_server();
        
        let err = session.call_tool("ghost", json!({})).err();
        assert!(matches!(err, Some(McpError::Server(_))));
        session.shutdown();
        let _ = fs::remove_file(script);
    }
}

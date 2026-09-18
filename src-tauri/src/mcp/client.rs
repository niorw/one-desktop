








use crate::mcp::model::{McpCapabilities, McpServer, McpTransport};
use crate::paths;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;
use tokio::runtime::Builder;

pub struct McpClient;

impl McpClient {
    
    pub fn test(server: &McpServer, timeout: Duration) -> Result<McpCapabilities, String> {
        match server.transport {
            McpTransport::Stdio => Self::test_stdio(server, timeout),
            McpTransport::Sse | McpTransport::Http => Self::test_http(server, timeout),
        }
    }

    fn test_http(server: &McpServer, timeout: Duration) -> Result<McpCapabilities, String> {
        let url = server.url.as_ref().ok_or("缺少 URL")?;
        let rt = Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| e.to_string())?;
        rt.block_on(async {
            let client = reqwest::Client::new();
            let resp = client
                .get(url)
                .timeout(timeout)
                .send()
                .await
                .map_err(|e| format!("连接失败: {}", e))?;
            let status = resp.status();
            if !status.is_success() && status != 404 {
                return Err(format!("HTTP 状态码 {}", status));
            }
            Ok::<_, String>(McpCapabilities::default())
        })
    }

    fn test_stdio(server: &McpServer, timeout: Duration) -> Result<McpCapabilities, String> {
        let command = server.command.as_ref().ok_or("缺少 command")?;
        let mut cmd = Command::new(command);
        cmd.args(&server.args)
            .envs(&server.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());

        
        
        
        if !server.id.is_empty() {
            let cwd = paths::mcp_server_dir(&server.id);
            let _ = std::fs::create_dir_all(&cwd);
            cmd.current_dir(&cwd);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("无法启动进程 {}: {}", command, e))?;

        let mut stdin = child.stdin.take().ok_or("无法打开子进程 stdin")?;
        let stdout = child.stdout.take().ok_or("无法打开子进程 stdout")?;

        
        let (tx, rx) = mpsc::sync_channel::<Value>(32);
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

        
        let init_params = json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": { "name": "OneDesktop", "version": "1.0.0" }
        });
        rpc_request(&mut stdin, &rx, timeout, "initialize", init_params, 1)?;

        
        let note = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        stdin
            .write_all(format!("{}\n", note).as_bytes())
            .map_err(|e| e.to_string())?;
        stdin.flush().ok();

        let mut caps = McpCapabilities::default();
        for (method, id) in [
            ("tools/list", 2u64),
            ("resources/list", 3u64),
            ("prompts/list", 4u64),
        ] {
            if let Ok(res) = rpc_request(&mut stdin, &rx, timeout, method, json!({}), id) {
                if let Some(arr) = res
                    .get("result")
                    .and_then(|r| r.get(list_key(method)).and_then(|v| v.as_array()))
                {
                    for item in arr {
                        let name = item
                            .get("name")
                            .and_then(|v| v.as_str())
                            .or_else(|| item.get("uri").and_then(|v| v.as_str()))
                            .unwrap_or("");
                        if !name.is_empty() {
                            match method {
                                "tools/list" => caps.tools.push(name.to_string()),
                                "resources/list" => caps.resources.push(name.to_string()),
                                "prompts/list" => caps.prompts.push(name.to_string()),
                                _ => {}
                            }
                        }
                    }
                }
            }
        }

        let _ = child.kill();
        let _ = child.wait();
        Ok(caps)
    }
}

fn list_key(method: &str) -> &'static str {
    match method {
        "tools/list" => "tools",
        "resources/list" => "resources",
        "prompts/list" => "prompts",
        _ => "",
    }
}



fn rpc_request(
    stdin: &mut std::process::ChildStdin,
    rx: &mpsc::Receiver<Value>,
    timeout: Duration,
    method: &str,
    params: Value,
    id: u64,
) -> Result<Value, String> {
    let req = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
    let bytes = format!("{}\n", req);
    stdin
        .write_all(bytes.as_bytes())
        .map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())?;
    loop {
        let msg = rx
            .recv_timeout(timeout)
            .map_err(|_| format!("等待 '{}' 响应超时", method))?;
        let msg_id = msg.get("id").and_then(|v| v.as_u64());
        if msg_id == Some(id) {
            if let Some(err) = msg.get("error") {
                return Err(format!("MCP 错误: {}", err));
            }
            return Ok(msg);
        }
    }
}

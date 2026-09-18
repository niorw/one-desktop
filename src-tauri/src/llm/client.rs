




use crate::agent::tool_registry::ToolDef;
use crate::llm::provider::LlmProvider;
use crate::llm::types::{ChatMessage, LlmResponse, ToolCallResult};
use futures_util::StreamExt;
use serde_json::Value;
use std::sync::OnceLock;
use std::time::Duration;










fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(30))
            .pool_idle_timeout(Duration::from_secs(90))
            .pool_max_idle_per_host(5)
            .build()
            .expect("Failed to create HTTP client")
    })
}


pub struct StreamCallbacks<'a, T: Fn(&str), U: Fn(&str)> {
    
    pub on_token: &'a T,
    
    pub on_thinking: &'a U,
}













struct LineAccumulator {
    buf: Vec<u8>,
}

impl LineAccumulator {
    fn new() -> Self {
        Self { buf: Vec::new() }
    }

    
    
    
    fn feed(&mut self, chunk: &[u8]) -> Option<String> {
        self.buf.extend_from_slice(chunk);
        let last_nl = self.buf.iter().rposition(|&b| b == b'\n')?;
        let split_at = last_nl + 1;
        let complete = self.buf[..split_at].to_vec();
        self.buf.drain(..split_at);
        Some(decode_sse_bytes(&complete))
    }

    
    
    fn flush(&mut self) -> String {
        if self.buf.is_empty() {
            return String::new();
        }
        let out = decode_sse_bytes(&self.buf);
        self.buf.clear();
        out
    }
}

fn decode_sse_bytes(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(e) => {
            tracing::warn!(
                target: "onedesktop.llm.client",
                error = %e,
                "SSE line bytes are not valid UTF-8; lossy decode"
            );
            String::from_utf8_lossy(bytes).into_owned()
        }
    }
}






pub async fn stream_chat(
    provider: &dyn LlmProvider,
    messages: &[ChatMessage],
    tools: &[ToolDef],
    temperature: f64,
    max_tokens: u32,
    callbacks: StreamCallbacks<'_, impl Fn(&str), impl Fn(&str)>,
    cancel_rx: tokio::sync::watch::Receiver<bool>,
) -> LlmResponse {
    stream_chat_inner(
        provider,
        messages,
        tools,
        temperature,
        max_tokens,
        &callbacks,
        cancel_rx,
    )
    .await
}

async fn stream_chat_inner(
    provider: &dyn LlmProvider,
    messages: &[ChatMessage],
    tools: &[ToolDef],
    temperature: f64,
    max_tokens: u32,
    callbacks: &StreamCallbacks<'_, impl Fn(&str), impl Fn(&str)>,
    cancel_rx: tokio::sync::watch::Receiver<bool>,
) -> LlmResponse {
    
    if *cancel_rx.borrow() {
        return LlmResponse::Cancelled;
    }
    let body = provider.build_request_body(messages, tools, temperature, max_tokens);

    tracing::debug!(
        target: "onedesktop.llm.client",
        url = %provider.chat_url(),
        model = %provider.model(),
        msg_count = messages.len(),
        "Sending streaming request"
    );

    
    
    
    let mut last_error: Option<String> = None;

    for attempt in 0..2 {
        
        let mut response = None;
        for send_attempt in 0..2 {
            
            
            let req = http_client().post(provider.chat_url());
            let req = if provider.api_key().is_empty() {
                req
            } else {
                req.header("Authorization", format!("Bearer {}", provider.api_key()))
            };
            match req
                .header("Content-Type", "application/json")
                .header("Accept", "text/event-stream")
                
                
                
                
                .header("Accept-Encoding", "identity")
                .json(&body)
                .send()
                .await
            {
                Ok(r) => {
                    response = Some(r);
                    break;
                }
                Err(e) if send_attempt == 0 && (e.is_connect() || e.is_timeout()) => {
                    tracing::warn!(
                        target: "onedesktop.llm.client",
                        attempt = send_attempt + 1,
                        error = %e,
                        "Retrying after network error"
                    );
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    continue;
                }
                Err(e) => return LlmResponse::Error(format!("Network error: {}", e)),
            }
        }

        let response = response.unwrap();

        if !response.status().is_success() {
            let status = response.status();
            let body_text = response.text().await.unwrap_or_default();
            tracing::error!(
                target: "onedesktop.llm.client",
                status = %status,
                body = %body_text,
                "LLM API returned error"
            );
            return LlmResponse::Error(format!("HTTP {}: {}", status, body_text));
        }

        
        
        
        let mut stream = response.bytes_stream();
        let mut full_content = String::new();
        let mut full_reasoning = String::new();
        let mut tool_calls_map: std::collections::BTreeMap<u64, (String, String)> =
            std::collections::BTreeMap::new();
        let mut total_tokens: u64 = 0;
        
        let mut total_prompt_tokens: u64 = 0;
        let mut total_output_tokens: u64 = 0;
        
        let mut total_reasoning_tokens: u64 = 0;
        let mut has_tool_call = false;
        
        
        let mut last_finish_reason: Option<String> = None;
        let mut line_acc = LineAccumulator::new();
        let mut stream_error: Option<String> = None;

        
        
        
        let mut process_sse_line = |line: &str| {
            let line = line.trim();
            if line.is_empty() || line == "data: [DONE]" {
                return;
            }
            let json_str = line.strip_prefix("data: ").unwrap_or(line);
            if json_str.is_empty() {
                return;
            }
            let parsed: Value = match serde_json::from_str(json_str) {
                Ok(v) => v,
                Err(e) => {
                    tracing::warn!(
                        target: "onedesktop.llm.client",
                        error = %e,
                        json_fragment = %json_str.chars().take(120).collect::<String>(),
                        "Failed to parse SSE line, skipping"
                    );
                    return;
                }
            };
            let delta = provider.parse_delta(&parsed);

            
            if let Some(t) = delta.usage_tokens {
                total_tokens = t;
            }
            if let Some(p) = delta.usage_prompt_tokens {
                total_prompt_tokens = p;
            }
            if let Some(o) = delta.usage_output_tokens {
                total_output_tokens = o;
            }
            if let Some(r) = delta.reasoning_tokens {
                total_reasoning_tokens = r;
            }

            
            if let Some(ref c) = delta.content {
                full_content.push_str(c);
                (callbacks.on_token)(c);
            }

            
            if let Some(ref rc) = delta.reasoning_content {
                full_reasoning.push_str(rc);
                (callbacks.on_thinking)(rc);
            }

            
            if let Some(ref fr) = delta.finish_reason {
                last_finish_reason = Some(fr.clone());
            }

            
            if let Some(name) = delta.tool_call_name {
                has_tool_call = true;
                let idx = delta.tool_call_index.unwrap_or(0);
                let entry = tool_calls_map.entry(idx).or_default();
                entry.0 = name;
            }
            if let Some(args) = delta.tool_call_args {
                let idx = delta.tool_call_index.unwrap_or(0);
                let entry = tool_calls_map.entry(idx).or_default();
                entry.1.push_str(&args);
            }
        };

        
        
        
        
        
        let idle_timeout = Duration::from_secs(120);
        'stream: loop {
            let next = match tokio::time::timeout(idle_timeout, stream.next()).await {
                Ok(None) => break 'stream, 
                Ok(Some(cr)) => cr,         
                Err(_) => {
                    stream_error = Some(format!(
                        "Stream idle timeout: no data received for {}s",
                        idle_timeout.as_secs()
                    ));
                    break 'stream;
                }
            };

            
            if *cancel_rx.borrow() {
                tracing::info!(target: "onedesktop.llm.client", "Stream cancelled by user");
                return LlmResponse::Cancelled;
            }

            let chunk = match next {
                Ok(c) => c,
                Err(e) => {
                    stream_error = Some(format!("Stream error: {}", e));
                    break 'stream;
                }
            };

            
            
            
            
            let Some(complete_text) = line_acc.feed(&chunk) else {
                continue;
            };

            for line in complete_text.lines() {
                process_sse_line(line);
            }
        }

        
        if stream_error.is_none() {
            let remaining = line_acc.flush();
            for line in remaining.lines() {
                process_sse_line(line);
            }
        }

        
        
        if let Some(err) = stream_error {
            if attempt == 0 && full_content.is_empty() && full_reasoning.is_empty() {
                tracing::warn!(
                    target: "onedesktop.llm.client",
                    error = %err,
                    "Stream failed before first token; retrying once"
                );
                last_error = Some(err);
                tokio::time::sleep(Duration::from_millis(400)).await;
                continue;
            }
            
            
            tracing::error!(
                target: "onedesktop.llm.client",
                error = %err,
                attempt = attempt,
                emitted_chars = full_content.chars().count(),
                "LLM stream failed; returning LlmError"
            );
            return LlmResponse::Error(err);
        }
        if has_tool_call {
            let calls: Vec<ToolCallResult> = tool_calls_map
                .values()
                .map(|(name, args)| ToolCallResult {
                    name: name.clone(),
                    arguments: args.clone(),
                })
                .collect();

            tracing::debug!(
                target: "onedesktop.llm.client",
                tool_count = calls.len(),
                "Tool calls detected"
            );

            
            let (prompt_tokens, output_tokens) = if total_prompt_tokens > 0 || total_output_tokens > 0 {
                (total_prompt_tokens, total_output_tokens)
            } else {
                (0, total_tokens)
            };

            return LlmResponse::ToolCalls {
                calls,
                reasoning_content: full_reasoning,
                plan_content: full_content,
                tokens: total_tokens,
                prompt_tokens,
                output_tokens,
                reasoning_tokens: total_reasoning_tokens,
            };
        } else {
            let (prompt_tokens, output_tokens) = if total_prompt_tokens > 0 || total_output_tokens > 0 {
                (total_prompt_tokens, total_output_tokens)
            } else {
                (0, total_tokens)
            };
            return LlmResponse::Text {
                content: full_content,
                reasoning_content: full_reasoning,
                tokens: total_tokens,
                prompt_tokens,
                output_tokens,
                reasoning_tokens: total_reasoning_tokens,
                finish_reason: last_finish_reason,
            };
        }
    }

    if let Some(err) = last_error {
        
        tracing::error!(
            target: "onedesktop.llm.client",
            error = %err,
            "LLM stream exhausted retries; returning LlmError"
        );
        LlmResponse::Error(err)
    } else {
        LlmResponse::Error("Stream failed after retry".to_string())
    }
}




pub async fn summarize_text(
    provider: &dyn LlmProvider,
    system: &str,
    user: &str,
    temperature: f64,
    max_tokens: u32,
) -> Result<String, String> {
    summarize_text_with_cancel(provider, system, user, temperature, max_tokens, None).await
}






pub async fn summarize_text_with_cancel(
    provider: &dyn LlmProvider,
    system: &str,
    user: &str,
    temperature: f64,
    max_tokens: u32,
    cancel_rx: Option<tokio::sync::watch::Receiver<bool>>,
) -> Result<String, String> {
    let messages = vec![ChatMessage::system(system), ChatMessage::user(user)];

    
    let cancel_rx = cancel_rx.unwrap_or_else(|| {
        let (_cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
        cancel_rx
    });
    let out = std::sync::Mutex::new(String::new());
    let callbacks = StreamCallbacks {
        on_token: &|t: &str| {
            out.lock().unwrap().push_str(t);
        },
        on_thinking: &|_: &str| {},
    };
    let resp = stream_chat(
        provider,
        &messages,
        &[],
        temperature,
        max_tokens,
        callbacks,
        cancel_rx,
    )
    .await;

    match resp {
        LlmResponse::Text { content, .. } => {
            let c = content.trim().to_string();
            if c.is_empty() {
                Err("LLM 返回空摘要".into())
            } else {
                Ok(c)
            }
        }
        LlmResponse::Cancelled => Err("摘要生成被取消".into()),
        LlmResponse::Error(e) => Err(e),
        
        LlmResponse::ToolCalls { .. } => {
            let collected = out.lock().unwrap().trim().to_string();
            if collected.is_empty() {
                Err("摘要生成异常（LLM 请求调用工具）".into())
            } else {
                Ok(collected)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    
    
    
    
    
    
    #[test]
    fn line_accumulator_preserves_split_multibyte_char() {
        let mut acc = LineAccumulator::new();
        let full = "日出\n".as_bytes();
        assert_eq!(full, b"\xE6\x97\xA5\xE5\x87\xBA\n", "test fixture sanity");

        
        let chunk1 = &full[..4];
        assert!(acc.feed(chunk1).is_none(), "no complete line yet");

        
        let chunk2 = &full[4..];
        let text = acc
            .feed(chunk2)
            .expect("second chunk must complete the line");
        assert_eq!(text, "日出\n", "split char must survive: {:?}", text);
        assert!(
            !text.contains('\u{FFFD}'),
            "no U+FFFD replacement chars may leak through"
        );
    }

    
    
    
    #[test]
    fn line_accumulator_handles_three_way_split() {
        let mut acc = LineAccumulator::new();
        
        let full = "明天\n".as_bytes();
        assert_eq!(full.len(), 7);

        assert!(acc.feed(&full[..1]).is_none(), "1 byte: nothing");
        assert!(acc.feed(&full[1..4]).is_none(), "4 bytes: nothing");
        let text = acc.feed(&full[4..]).expect("7 bytes: line complete");
        assert_eq!(text, "明天\n");
        assert!(!text.contains('\u{FFFD}'));
    }

    
    
    #[test]
    fn line_accumulator_returns_multiple_complete_lines() {
        let mut acc = LineAccumulator::new();
        let text = acc
            .feed(b"data: {\"a\":1}\ndata: {\"b\":2}\n")
            .expect("two lines");
        assert_eq!(text, "data: {\"a\":1}\ndata: {\"b\":2}\n");
    }

    
    
    #[test]
    fn line_accumulator_keeps_only_trailing_bytes() {
        let mut acc = LineAccumulator::new();
        let text = acc.feed(b"line1\nline2-partial").expect("line1");
        assert_eq!(text, "line1\n");
        let text = acc.feed(b"-more\n").expect("line2");
        assert_eq!(text, "line2-partial-more\n");
    }

    
    
    #[test]
    fn line_accumulator_flush_yields_trailing_partial_line() {
        let mut acc = LineAccumulator::new();
        assert!(acc.feed(b"data: hello").is_none());
        let tail = acc.flush();
        assert_eq!(tail, "data: hello");
    }

    
    
    #[test]
    fn line_accumulator_flush_empty_is_noop() {
        let mut acc = LineAccumulator::new();
        acc.feed(b"complete\n").expect("line");
        let tail = acc.flush();
        assert!(tail.is_empty());
    }

    
    
    #[test]
    fn decode_sse_bytes_strict_for_valid_utf8() {
        let out = decode_sse_bytes("日出\n".as_bytes());
        assert_eq!(out, "日出\n");
        assert!(!out.contains('\u{FFFD}'));
    }
}







use crate::agent::tool_registry::{ExecutableTool, ToolDef, ToolExecContext};
use async_trait::async_trait;
use serde_json::{json, Value};

pub struct SendToWorkerTool;

#[async_trait]
impl ExecutableTool for SendToWorkerTool {
    async fn execute(&self, args: Value, ctx: &ToolExecContext) -> Result<String, String> {
        let target = args["target_worker"]
            .as_str()
            .ok_or("缺少必填参数 target_worker（目标 Worker id）")?;
        let message = args["message"]
            .as_str()
            .ok_or("缺少必填参数 message（消息内容）")?;
        if message.trim().is_empty() {
            return Err("message 不能为空".into());
        }

        let sender = ctx
            .group_sender
            .as_ref()
            .ok_or("当前会话不支持 Worker 间直连消息（仅群 Worker 会话可调用）")?;
        let session = ctx
            .sender_session
            .clone()
            .ok_or("无法确定发送者会话（sender_session 为空）")?;

        match sender
            .send_to_worker(session, target.to_string(), message.to_string())
            .await
        {
            Ok(()) => Ok(format!(
                "已通过拓扑策略向 Worker {} 发送直连消息，目标 Worker 将被唤起回复。",
                target
            )),
            Err(e) => Err(format!("直连消息被拒绝：{}", e)),
        }
    }
}

impl From<SendToWorkerTool> for ToolDef {
    fn from(_: SendToWorkerTool) -> Self {
        ToolDef {
            name: "send_to_worker".into(),
            description: concat!(
                "向群内另一个 Worker 发送点对点直连消息（F5 Worker 间通信）。",
                "目标 Worker 会被唤起并回复。消息受群通信拓扑策略约束：星形拓扑下默认禁止 Worker 互发，",
                "全连通/自定义拓扑下按授权边放行。参数 target_worker 为 Worker id（从群成员名册选取），",
                "message 为消息正文。被拓扑策略拒绝时会明确报错，不应反复重试。"
            )
            .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "target_worker": {
                        "type": "string",
                        "description": "目标 Worker 的 id（如 w2），从群成员名册选取"
                    },
                    "message": {
                        "type": "string",
                        "description": "要发送给目标 Worker 的消息正文"
                    }
                },
                "required": ["target_worker", "message"]
            }),
        }
    }
}










use crate::agent::tool_registry::{ExecutableTool, ToolDef, ToolExecContext};
use crate::group::topology_router::parse_rt_session;
use async_trait::async_trait;
use serde_json::{json, Value};


fn board_namespace(sender_session: &str) -> Option<String> {
    parse_rt_session(sender_session).map(|(g, _)| format!("bb:{}", g))
}


pub struct ReadStateTool;

#[async_trait]
impl ExecutableTool for ReadStateTool {
    async fn execute(&self, args: Value, ctx: &ToolExecContext) -> Result<String, String> {
        let key = args["key"].as_str().ok_or("缺少必填参数 key（黑板键名）")?;
        let session = ctx
            .sender_session
            .clone()
            .ok_or("无法确定发送者会话（sender_session 为空）")?;
        let ns = board_namespace(&session)
            .ok_or("当前会话不是群 Worker 会话，read_state 仅群内可用")?;
        let board = ctx
            .blackboard
            .as_ref()
            .ok_or("当前会话不支持共享黑板（黑板端口未注入）")?;

        match board.read(&ns, key) {
            Some((value, version)) => Ok(format!(
                "黑板键 `{}` 当前值（版本 {}）：\n{}",
                key, version, value
            )),
            None => Err(format!("黑板键 `{}` 不存在（可能尚未由群主声明）", key)),
        }
    }
}


pub struct UpdateStateTool;

#[async_trait]
impl ExecutableTool for UpdateStateTool {
    async fn execute(&self, args: Value, ctx: &ToolExecContext) -> Result<String, String> {
        let key = args["key"].as_str().ok_or("缺少必填参数 key（黑板键名）")?;
        let value = args["value"].as_str().ok_or("缺少必填参数 value（新值）")?;
        let expected_version = args["expected_version"]
            .as_u64()
            .ok_or("缺少必填参数 expected_version（读取时返回的版本号，用于乐观锁）")?;

        let session = ctx
            .sender_session
            .clone()
            .ok_or("无法确定发送者会话（sender_session 为空）")?;
        let ns = board_namespace(&session)
            .ok_or("当前会话不是群 Worker 会话，update_state 仅群内可用")?;
        let board = ctx
            .blackboard
            .as_ref()
            .ok_or("当前会话不支持共享黑板（黑板端口未注入）")?;

        
        if board.read(&ns, key).is_none() {
            return Err(format!(
                "黑板键 `{}` 不存在，不能新建未声明的 key。请由群主在建群或黑板管理中声明该键。",
                key
            ));
        }

        match board.cas_write(&ns, key, value, expected_version) {
            Ok(new_version) => Ok(format!(
                "黑板键 `{}` 已更新为版本 {}。后续读取请使用此版本号作为 expected_version。",
                key, new_version
            )),
            Err(e) => match e {
                crate::agent::ports::BlackboardError::Conflict(current) => Err(format!(
                    "版本冲突：期望版本 {}，但当前已是版本 {}。请先 read_state 读取最新值再更新。",
                    expected_version, current
                )),
                crate::agent::ports::BlackboardError::RoutingDenied(reason) => {
                    Err(format!("拓扑策略拒绝写入共享黑板：{}", reason))
                }
                crate::agent::ports::BlackboardError::Store(msg) => {
                    Err(format!("黑板存储失败：{}", msg))
                }
            },
        }
    }
}

impl From<ReadStateTool> for ToolDef {
    fn from(_: ReadStateTool) -> Self {
        ToolDef {
            name: "read_state".into(),
            description: concat!(
                "读取群共享黑板（F7 结构化黑板）上某个键的当前值与版本号。",
                "黑板是群内 Worker 共享中间产物/状态的场所，替代「文件传话」。",
                "参数 key 为键名。返回的版本号应作为后续 update_state 的 expected_version。",
                "仅在群 Worker 会话内可用。"
            )
            .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "key": { "type": "string", "description": "要读取的黑板键名" }
                },
                "required": ["key"]
            }),
        }
    }
}

impl From<UpdateStateTool> for ToolDef {
    fn from(_: UpdateStateTool) -> Self {
        ToolDef {
            name: "update_state".into(),
            description: concat!(
                "更新群共享黑板（F7 结构化黑板）上某个已存在的键（版本化 CAS，乐观锁）。",
                "不能新建未声明的 key——新建归群主在建群/黑板管理时声明。",
                "参数 key 为键名，value 为新值，expected_version 为读取时返回的版本号；",
                "若版本已变（他人先写），会报错并附带当前版本号，需重新读取后重试。",
                "仅在群 Worker 会话内可用。"
            )
            .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "key": { "type": "string", "description": "要更新的黑板键名（必须已存在）" },
                    "value": { "type": "string", "description": "写入的新值" },
                    "expected_version": { "type": "integer", "description": "读取时返回的版本号，用于乐观锁" }
                },
                "required": ["key", "value", "expected_version"]
            }),
        }
    }
}

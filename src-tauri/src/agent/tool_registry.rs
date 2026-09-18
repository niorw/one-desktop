





use async_trait::async_trait;
use crate::agent::ports::Blackboard;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};


#[derive(Debug, Clone)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    
    pub parameters: Value,
}








#[derive(Clone, Default)]
pub struct ToolExecContext {
    pub workspace_root: Option<PathBuf>,
    
    
    pub cancel: Option<Arc<AtomicBool>>,
    
    pub enforce_root: bool,
    
    pub group_sender: Option<Arc<dyn GroupMessageSender>>,
    
    pub blackboard: Option<Arc<dyn Blackboard>>,
    
    pub sender_session: Option<String>,
    
    
    pub write_gate: Option<Arc<crate::agent::write_gate::WriteGate>>,
    
    pub run_id: Option<String>,
    
    
    pub workspace_id: Option<String>,
    
    
    
    
    
    pub written_files: Option<Arc<Mutex<Vec<String>>>>,
    
    
    
    pub tmp_root: Option<PathBuf>,
}

impl std::fmt::Debug for ToolExecContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ToolExecContext")
            .field("workspace_root", &self.workspace_root)
            .field("enforce_root", &self.enforce_root)
            .field("has_group_sender", &self.group_sender.is_some())
            .field("has_blackboard", &self.blackboard.is_some())
            .field("sender_session", &self.sender_session)
            .field("has_write_gate", &self.write_gate.is_some())
            .field("run_id", &self.run_id)
            .field("workspace_id", &self.workspace_id)
            .field("has_written_files", &self.written_files.is_some())
            .field("tmp_root", &self.tmp_root)
            .finish()
    }
}





#[async_trait]
pub trait GroupMessageSender: Send + Sync {
    
    
    
    async fn send_to_worker(
        &self,
        from_session: String,
        to_worker: String,
        content: String,
    ) -> Result<(), String>;
}


#[async_trait]
pub trait ExecutableTool: Send + Sync {
    
    
    
    
    async fn execute(&self, args: Value, ctx: &ToolExecContext) -> Result<String, String>;
}


pub struct ToolRegistry {
    tools: HashMap<String, (ToolDef, Arc<dyn ExecutableTool>)>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self {
            tools: HashMap::new(),
        }
    }

    
    pub fn register<D, E>(&mut self, def: D, executor: E)
    where
        D: Into<ToolDef>,
        E: ExecutableTool + 'static,
    {
        let def = def.into();
        self.tools
            .insert(def.name.clone(), (def, Arc::new(executor)));
    }

    
    pub fn list_definitions(&self) -> Vec<&ToolDef> {
        self.tools.values().map(|(def, _)| def).collect()
    }

    
    pub async fn execute(
        &self,
        name: &str,
        args: Value,
        ctx: &ToolExecContext,
    ) -> Result<String, String> {
        let (def, executor) = self
            .tools
            .get(name)
            .ok_or_else(|| format!("Tool not found: {}", name))?;
        tracing::debug!(
            target: "onedesktop.agent.tool",
            tool_name = %def.name,
            "Executing tool"
        );
        executor.execute(args, ctx).await
    }

    
    pub fn has_tool(&self, name: &str) -> bool {
        self.tools.contains_key(name)
    }
}

impl Default for ToolRegistry {
    fn default() -> Self {
        Self::new()
    }
}

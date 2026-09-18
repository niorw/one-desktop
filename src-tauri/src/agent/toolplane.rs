
















use crate::agent::tool_registry::{ToolDef, ToolExecContext, ToolRegistry};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::RwLock;
use std::time::Instant;


#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolOutcome {
    
    Ok { content: String, ms: u64 },
    
    Failed { message: String, retryable: bool },
    
    Unavailable { reason: UnavailableReason },
}


#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UnavailableReason {
    
    Network(String),
    NotFound,
    Timeout,
    Denied,
    ProviderDown(String),
}
impl UnavailableReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            UnavailableReason::Network(_) => "network",
            UnavailableReason::NotFound => "not_found",
            UnavailableReason::Timeout => "timeout",
            UnavailableReason::Denied => "denied",
            UnavailableReason::ProviderDown(_) => "provider_down",
        }
    }
}


#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolOrigin {
    Builtin,
    
    Mcp(String),
    Skill(String),
}
impl ToolOrigin {
    pub fn label(&self) -> String {
        match self {
            ToolOrigin::Builtin => "builtin".to_string(),
            ToolOrigin::Mcp(id) => format!("mcp:{}", id),
            ToolOrigin::Skill(id) => format!("skill:{}", id),
        }
    }
}


#[derive(Debug, Clone, Default)]
pub enum ToolAllow {
    #[default]
    All,
    
    Only(HashSet<String>),
    
    AllExcept(HashSet<String>),
}


#[derive(Debug, Clone, Default)]
pub struct ToolScope {
    pub seat: Option<String>,
    pub allow: ToolAllow,
}
impl ToolScope {
    pub fn all() -> Self {
        Self {
            seat: None,
            allow: ToolAllow::All,
        }
    }
    pub fn only(names: &[&str]) -> Self {
        Self {
            seat: None,
            allow: ToolAllow::Only(names.iter().map(|s| s.to_string()).collect()),
        }
    }
    
    pub fn all_except(names: &[&str]) -> Self {
        Self {
            seat: None,
            allow: ToolAllow::AllExcept(names.iter().map(|s| s.to_string()).collect()),
        }
    }
    
    pub fn allows(&self, name: &str) -> bool {
        match &self.allow {
            ToolAllow::All => true,
            ToolAllow::Only(set) => set.contains(name),
            ToolAllow::AllExcept(set) => !set.contains(name),
        }
    }
}


#[async_trait]
pub trait ToolProvider: Send + Sync {
    fn origin(&self) -> ToolOrigin;
    async fn list(&self) -> Result<Vec<ToolDef>, String>;
    async fn invoke(&self, name: &str, args: Value, ctx: &ToolExecContext) -> ToolOutcome;
    
    async fn health(&self) -> bool;
}


#[async_trait]
pub trait ToolPlane: Send + Sync {
    
    async fn list(&self, scope: &ToolScope) -> Vec<ToolDef>;
    fn has_tool(&self, name: &str) -> bool;
    async fn invoke(&self, name: &str, args: Value, ctx: &ToolExecContext) -> ToolOutcome;
    fn origin_of(&self, name: &str) -> Option<ToolOrigin>;
    
    fn register_provider(&self, p: Arc<dyn ToolProvider>);
    
    fn remove_provider(&self, origin_label: &str);
}







pub struct ToolPlaneImpl {
    providers: RwLock<Vec<Arc<dyn ToolProvider>>>,
    cache: RwLock<HashMap<String, (usize, ToolDef)>>,
}







impl Default for ToolPlaneImpl {
    fn default() -> Self {
        Self::new()
    }
}

impl ToolPlaneImpl {
    pub fn new() -> Self {
        Self {
            providers: RwLock::new(Vec::new()),
            cache: RwLock::new(HashMap::new()),
        }
    }

    
    
    async fn rebuild(&self) {
        let snapshot: Vec<Arc<dyn ToolProvider>> = self.providers.read().unwrap().clone();
        let mut catalog: HashMap<String, (usize, ToolDef)> = HashMap::new();
        for (idx, p) in snapshot.iter().enumerate() {
            if let Ok(defs) = p.list().await {
                for def in defs {
                    catalog.entry(def.name.clone()).or_insert((idx, def));
                }
            }
        }
        *self.cache.write().unwrap() = catalog;
    }

    fn cache_fresh(&self) -> bool {
        !self.cache.read().unwrap().is_empty()
    }
}







fn inject_intent_param(mut def: ToolDef) -> ToolDef {
    let ToolDef { parameters, .. } = &mut def;
    let Value::Object(params) = parameters else { return def };
    
    if params
        .get("properties")
        .and_then(|p| p.as_object())
        .map(|o| o.contains_key("intent"))
        .unwrap_or(false)
    {
        return def;
    }
    let props = params
        .entry("properties")
        .or_insert_with(|| Value::Object(Default::default()))
        .as_object_mut()
        .expect("tool parameters.properties 必须为对象");
    props.insert(
        "intent".to_string(),
        json!({
            "type": "string",
            "description": "调用此工具的目的：用中文一句话说明你为什么要调用它、要达成什么。每次调用都必须填写，让用户理解你的决策。"
        }),
    );
    let required = params
        .entry("required")
        .or_insert_with(|| Value::Array(vec![]));
    if let Value::Array(arr) = required {
        if !arr.iter().any(|v| v.as_str() == Some("intent")) {
            arr.push(Value::String("intent".to_string()));
        }
    }
    def
}

#[async_trait]
impl ToolPlane for ToolPlaneImpl {
    async fn list(&self, scope: &ToolScope) -> Vec<ToolDef> {
        if !self.cache_fresh() {
            self.rebuild().await;
        }
        let cache = self.cache.read().unwrap();
        cache
            .values()
            .filter(|(_, def)| scope.allows(&def.name))
            .map(|(_, def)| inject_intent_param(def.clone()))
            .collect()
    }

    fn has_tool(&self, name: &str) -> bool {
        if !self.cache_fresh() {
            return false;
        }
        self.cache.read().unwrap().contains_key(name)
    }

    async fn invoke(&self, name: &str, args: Value, ctx: &ToolExecContext) -> ToolOutcome {
        if !self.cache_fresh() {
            self.rebuild().await;
        }
        let idx = self.cache.read().unwrap().get(name).map(|(i, _)| *i);
        let Some(idx) = idx else {
            return ToolOutcome::Unavailable {
                reason: UnavailableReason::NotFound,
            };
        };
        let provider = self.providers.read().unwrap().get(idx).cloned();
        match provider {
            Some(p) => p.invoke(name, args, ctx).await,
            None => ToolOutcome::Unavailable {
                reason: UnavailableReason::NotFound,
            },
        }
    }

    fn origin_of(&self, name: &str) -> Option<ToolOrigin> {
        if !self.cache_fresh() {
            return None;
        }
        let cache = self.cache.read().unwrap();
        let (idx, _) = cache.get(name)?;
        let providers = self.providers.read().unwrap();
        providers.get(*idx).map(|p| p.origin())
    }

    fn register_provider(&self, p: Arc<dyn ToolProvider>) {
        self.providers.write().unwrap().push(p);
        self.cache.write().unwrap().clear();
    }

    fn remove_provider(&self, origin_label: &str) {
        self.providers
            .write()
            .unwrap()
            .retain(|p| p.origin().label() != origin_label);
        self.cache.write().unwrap().clear();
    }
}


pub struct BuiltinProvider {
    registry: Arc<ToolRegistry>,
}

impl BuiltinProvider {
    pub fn new(registry: Arc<ToolRegistry>) -> Self {
        Self { registry }
    }
}

#[async_trait]
impl ToolProvider for BuiltinProvider {
    fn origin(&self) -> ToolOrigin {
        ToolOrigin::Builtin
    }

    async fn list(&self) -> Result<Vec<ToolDef>, String> {
        Ok(self
            .registry
            .list_definitions()
            .into_iter()
            .cloned()
            .collect())
    }

    async fn invoke(&self, name: &str, args: Value, ctx: &ToolExecContext) -> ToolOutcome {
        let start = Instant::now();
        match self.registry.execute(name, args, ctx).await {
            Ok(content) => ToolOutcome::Ok {
                content,
                ms: start.elapsed().as_millis() as u64,
            },
            Err(message) => ToolOutcome::Failed {
                message,
                retryable: true,
            },
        }
    }

    async fn health(&self) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::tool_registry::{ExecutableTool, ToolDef};
    use async_trait::async_trait;
    use serde_json::json;

    struct EchoTool;
    #[async_trait]
    impl ExecutableTool for EchoTool {
        async fn execute(&self, args: Value, _ctx: &ToolExecContext) -> Result<String, String> {
            Ok(format!(
                "echo:{}",
                args.get("text").and_then(|v| v.as_str()).unwrap_or("")
            ))
        }
    }

    fn def(name: &str, desc: &str) -> ToolDef {
        ToolDef {
            name: name.to_string(),
            description: desc.to_string(),
            parameters: json!({ "type": "object", "properties": {} }),
        }
    }

    fn builtin_registry() -> Arc<ToolRegistry> {
        let mut reg = ToolRegistry::new();
        reg.register(def("echo", "echo text"), EchoTool);
        Arc::new(reg)
    }

    #[tokio::test]
    async fn builtin_list_and_invoke() {
        let plane = ToolPlaneImpl::new();
        plane.register_provider(Arc::new(BuiltinProvider::new(builtin_registry())));
        let defs = plane.list(&ToolScope::all()).await;
        assert_eq!(defs.len(), 1);
        assert_eq!(defs[0].name, "echo");

        assert!(plane.has_tool("echo"));
        assert_eq!(
            plane.origin_of("echo"),
            Some(ToolOrigin::Builtin)
        );

        let out = plane
            .invoke("echo", json!({ "text": "hi" }), &ToolExecContext::default())
            .await;
        match out {
            ToolOutcome::Ok { content, .. } => assert_eq!(content, "echo:hi"),
            other => panic!("expected Ok, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn scope_filter_works() {
        let plane = ToolPlaneImpl::new();
        plane.register_provider(Arc::new(BuiltinProvider::new(builtin_registry())));

        
        assert!(plane.list(&ToolScope::only(&[])).await.is_empty());
        assert_eq!(plane.list(&ToolScope::only(&["echo"])).await.len(), 1);
        
        let except = ToolScope {
            seat: None,
            allow: ToolAllow::AllExcept(["echo".to_string()].into_iter().collect()),
        };
        assert!(plane.list(&except).await.is_empty());
    }

    #[tokio::test]
    async fn not_found_returns_unavailable() {
        let plane = ToolPlaneImpl::new();
        plane.register_provider(Arc::new(BuiltinProvider::new(builtin_registry())));
        let out = plane
            .invoke("nope", json!({}), &ToolExecContext::default())
            .await;
        assert_eq!(
            out,
            ToolOutcome::Unavailable {
                reason: UnavailableReason::NotFound
            }
        );
    }
}

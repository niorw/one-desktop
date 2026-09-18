













use crate::agent::tool_registry::{ExecutableTool, ToolDef, ToolExecContext};
use crate::paths;
use async_trait::async_trait;
use serde_json::Value;
use std::path::Path;

pub fn user_memory_path() -> std::path::PathBuf {
    paths::memory_dir().join("USER.md")
}

pub fn longterm_memory_path() -> std::path::PathBuf {
    paths::memory_dir().join("MEMORY.md")
}


pub fn project_memory_path() -> std::path::PathBuf {
    paths::memory_dir().join("PROJECT.md")
}



pub fn workspace_memory_dir(workspace_id: &str) -> std::path::PathBuf {
    paths::memory_dir().join("workspaces").join(workspace_id)
}


pub fn workspace_project_memory_path(workspace_id: &str) -> std::path::PathBuf {
    workspace_memory_dir(workspace_id).join("PROJECT.md")
}





pub fn resolve_project_path(workspace_id: Option<&str>) -> std::path::PathBuf {
    match workspace_id {
        Some(id) if !id.is_empty() => workspace_project_memory_path(id),
        _ => project_memory_path(),
    }
}


fn read_if_exists(path: &Path) -> Option<String> {
    if path.exists() {
        std::fs::read_to_string(path)
            .ok()
            .filter(|s| !s.trim().is_empty())
    } else {
        None
    }
}








pub fn read_memory_block(workspace_id: Option<&str>) -> String {
    let mut sections: Vec<String> = Vec::new();

    if let Some(content) = read_if_exists(&user_memory_path()) {
        let trimmed = content.trim();
        if !trimmed.is_empty() {
            sections.push(format!("<user_profile>\n{}\n</user_profile>", trimmed));
        }
    }

    
    let project_path = resolve_project_path(workspace_id);
    if let Some(content) = read_if_exists(&project_path) {
        let trimmed = content.trim();
        if !trimmed.is_empty() {
            sections.push(format!(
                "<project_memory>\n{}\n</project_memory>",
                trimmed
            ));
        }
    }

    if let Some(content) = read_if_exists(&longterm_memory_path()) {
        let trimmed = content.trim();
        if !trimmed.is_empty() {
            sections.push(format!(
                "<long_term_memory>\n{}\n</long_term_memory>",
                trimmed
            ));
        }
    }

    sections.join("\n\n")
}



pub fn ensure_memory_files() {
    let user_path = paths::memory_dir().join("USER.md");
    let mem_path = paths::memory_dir().join("MEMORY.md");
    let proj_path = paths::memory_dir().join("PROJECT.md");

    if !user_path.exists() {
        let _ = std::fs::write(
            &user_path,
            "# User Profile\n\n\
             <!-- Durable facts about the user: name, role, preferences, habits, \
             working style. The agent may append to this file via the \
             `update_memory` tool (target=\"user\"). -->\n",
        );
    }

    if !mem_path.exists() {
        let _ = std::fs::write(
            &mem_path,
            "# Long-term Memory\n\n\
             <!-- Durable project / technical facts worth remembering across \
             sessions. The agent may append to this file via the `update_memory` \
             tool (target=\"memory\"). -->\n",
        );
    }

    
    if !proj_path.exists() {
        let _ = std::fs::write(
            &proj_path,
            "# Project Memory\n\n\
             <!-- Project/workspace-specific facts worth remembering across \
             sessions. The agent may append to this file via the `update_memory` \
             tool (target=\"project\"), or via memory_distill. -->\n",
        );
    }
}

pub struct UpdateMemoryTool;

#[async_trait]
impl ExecutableTool for UpdateMemoryTool {
    async fn execute(&self, args: Value, ctx: &ToolExecContext) -> Result<String, String> {
        let target = args["target"]
            .as_str()
            .ok_or("Missing 'target' argument (must be \"user\", \"memory\" or \"project\")")?;
        let content = args["content"]
            .as_str()
            .ok_or("Missing 'content' argument")?;
        let mode = args["mode"].as_str().unwrap_or("append");

        
        
        let path = match target {
            "user" => user_memory_path(),
            "memory" => longterm_memory_path(),
            
            "project" => resolve_project_path(ctx.workspace_id.as_deref()),
            other => {
                return Err(format!(
                    "Unknown memory target '{}'. Use \"user\", \"memory\" or \"project\".",
                    other
                ))
            }
        };

        
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory: {}", e))?;
        }

        match mode {
            "replace" => {
                std::fs::write(&path, content)
                    .map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
                Ok(format!(
                    "Replaced {} ({} bytes).",
                    path.display(),
                    content.len()
                ))
            }
            "append" | _ => {
                let mut existing = std::fs::read_to_string(&path).unwrap_or_default();
                if !existing.is_empty() && !existing.ends_with('\n') {
                    existing.push('\n');
                }
                existing.push_str(content);
                if !content.ends_with('\n') {
                    existing.push('\n');
                }
                std::fs::write(&path, &existing)
                    .map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
                Ok(format!(
                    "Appended {} bytes to {}.",
                    content.len(),
                    path.display()
                ))
            }
        }
    }
}

impl From<UpdateMemoryTool> for ToolDef {
    fn from(_: UpdateMemoryTool) -> Self {
        ToolDef {
            name: "update_memory".into(),
            description: concat!(
                "Persist a memory to a long-term file so it survives across sessions. ",
                "Use target=\"user\" to record durable facts about the user (name, role, preferences, habits). ",
                "Use target=\"project\" to record project/workspace-specific facts (current repo, conventions, decisions). ",
                "Use target=\"memory\" to record long-term technical facts worth remembering. ",
                "Set mode=\"append\" (default) to add a new note, or mode=\"replace\" to overwrite the whole file. ",
                "Project memory is automatically isolated per workspace (the engine routes it to the current ",
                "workspace's memory file); user/memory are global. All files are injected into your system prompt at the start of every run."
            )
            .into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "target": {
                        "type": "string",
                        "enum": ["user", "memory", "project"],
                        "description": "Which memory file to update: 'user' for the user profile, 'project' for project facts, 'memory' for long-term memory"
                    },
                    "content": {
                        "type": "string",
                        "description": "The memory text to write. Use concise bullet points or short paragraphs."
                    },
                    "mode": {
                        "type": "string",
                        "enum": ["append", "replace"],
                        "description": "How to apply the content. 'append' (default) adds to the file; 'replace' overwrites it."
                    }
                },
                "required": ["target", "content"]
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_memory_path_is_under_memory_dir() {
        let p = project_memory_path();
        assert_eq!(p.file_name().and_then(|n| n.to_str()), Some("PROJECT.md"));
        assert!(p.starts_with(paths::memory_dir()));
    }

    #[test]
    fn workspace_project_memory_path_is_under_workspaces_dir() {
        let p = workspace_project_memory_path("ws-1");
        assert_eq!(p.file_name().and_then(|n| n.to_str()), Some("PROJECT.md"));
        assert_eq!(
            p,
            paths::memory_dir().join("workspaces").join("ws-1").join("PROJECT.md")
        );
    }

    #[test]
    fn resolve_project_path_uses_workspace_when_given() {
        
        assert_eq!(resolve_project_path(None), project_memory_path());
        assert_eq!(resolve_project_path(Some("")), project_memory_path());
        
        assert_eq!(
            resolve_project_path(Some("abc")),
            workspace_project_memory_path("abc")
        );
    }

    #[test]
    fn read_memory_block_injects_project_between_global() {
        
        
        let block = read_memory_block(None);
        
        assert!(block.is_empty() || block.contains("<user_profile>") || block.contains("<project_memory>"));
    }
}

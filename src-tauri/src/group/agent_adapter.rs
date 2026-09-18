






use crate::group::agent_profile::{
    default_isolation, default_permission_mode, AgentProfile, AgentProfileExt,
    CreateAgentProfilePayload,
};
use serde::{Deserialize, Serialize};


#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalAgentEntry {
    pub name: String,
    pub path: String,
    
    pub source: String,
}
















pub fn parse_agent_md(content: &str) -> Result<(CreateAgentProfilePayload, AgentProfileExt), String> {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let (fm, body) = split_frontmatter(content)?;

    let name = extract_yaml_value(&fm, "name").ok_or("agent 缺少 frontmatter `name`")?;
    let description = extract_yaml_value(&fm, "description").unwrap_or_default();
    let model = extract_yaml_value(&fm, "model").unwrap_or_else(|| "deepseek-chat".into());
    let tools = extract_yaml_list(&fm, "tools");
    let disallowed_tools = extract_yaml_list(&fm, "disallowed_tools");
    let permission_mode =
        extract_yaml_value(&fm, "permission_mode").unwrap_or_else(default_permission_mode);
    let max_turns = extract_yaml_u32(&fm, "max_turns").unwrap_or(0);
    let isolation = extract_yaml_value(&fm, "isolation").unwrap_or_else(default_isolation);

    let system_prompt = body.trim().to_string();
    if system_prompt.is_empty() {
        return Err("agent 正文（system prompt）为空".into());
    }

    let payload = CreateAgentProfilePayload {
        name: name.clone(),
        model,
        system_prompt,
        capabilities: vec![],
        skills: vec![],
        mcp: vec![],
        tools: tools.clone(),
    };
    
    let _ = description;

    let ext = AgentProfileExt {
        disallowed_tools,
        plugins: vec![],
        permission_mode,
        max_turns,
        isolation,
    };
    Ok((payload, ext))
}





pub fn render_agent_md(p: &AgentProfile, redact: bool) -> String {
    let description = if redact {
        "[REDACTED]".to_string()
    } else {
        derive_description(&p.system_prompt)
    };
    let mut out = String::new();
    out.push_str("---\n");
    out.push_str(&format!("name: {}\n", p.name));
    out.push_str(&format!("description: {}\n", description));
    if !p.tools.is_empty() {
        out.push_str(&format!("tools: {}\n", p.tools.join(", ")));
    }
    out.push_str(&format!("model: {}\n", p.model));
    if p.permission_mode != default_permission_mode() {
        out.push_str(&format!("permission_mode: {}\n", p.permission_mode));
    }
    if p.max_turns > 0 {
        out.push_str(&format!("max_turns: {}\n", p.max_turns));
    }
    if !p.disallowed_tools.is_empty() {
        out.push_str(&format!("disallowed_tools: {}\n", p.disallowed_tools.join(", ")));
    }
    if p.isolation != default_isolation() {
        out.push_str(&format!("isolation: {}\n", p.isolation));
    }
    out.push_str("---\n\n");
    if redact {
        out.push_str("[REDACTED system prompt]\n");
    } else {
        out.push_str(&p.system_prompt);
        out.push('\n');
    }
    out
}



fn split_frontmatter(content: &str) -> Result<(String, String), String> {
    let rest = content
        .strip_prefix("---")
        .ok_or("缺少 frontmatter 分隔符 `---`")?;
    let end = rest.find("\n---").ok_or("frontmatter 未闭合")?;
    let fm = rest[..end].to_string();
    let body = rest[end + 4..].to_string(); 
    Ok((fm, body))
}

fn extract_yaml_value(fm: &str, key: &str) -> Option<String> {
    fm.lines().find_map(|line| {
        let line = line.trim();
        if let Some(stripped) = line.strip_prefix(&format!("{}:", key)) {
            let v = stripped
                .trim()
                .trim_matches('"')
                .trim_matches('\'')
                .to_string();
            if v.is_empty() {
                None
            } else {
                Some(v)
            }
        } else {
            None
        }
    })
}

fn extract_yaml_list(fm: &str, key: &str) -> Vec<String> {
    extract_yaml_value(fm, key)
        .map(|v| {
            v.split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn extract_yaml_u32(fm: &str, key: &str) -> Option<u32> {
    extract_yaml_value(fm, key)?.parse::<u32>().ok()
}


fn derive_description(system_prompt: &str) -> String {
    let first_line = system_prompt
        .lines()
        .map(|l| l.trim())
        .find(|l| !l.is_empty())
        .unwrap_or("OneDesktop agent")
        .to_string();
    let truncated: String = first_line.chars().take(120).collect();
    if truncated.chars().count() < first_line.chars().count() {
        format!("{}…", truncated)
    } else {
        truncated
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::group::agent_profile::default_provider;

    const SAMPLE: &str = r#"---
name: researcher
description: 深度研究助手
tools: Read, Grep, Glob, WebFetch
model: sonnet
permission_mode: plan
max_turns: 20
disallowed_tools: Bash, Write
isolation: sandbox
---
You are a meticulous researcher.
Always cite sources.
"#;

    #[test]
    fn parses_claude_agent_md() {
        let (p, ext) = parse_agent_md(SAMPLE).expect("parse ok");
        assert_eq!(p.name, "researcher");
        assert_eq!(p.model, "sonnet");
        assert_eq!(p.tools, vec!["Read", "Grep", "Glob", "WebFetch"]);
        assert_eq!(ext.permission_mode, "plan");
        assert_eq!(ext.max_turns, 20);
        assert_eq!(ext.disallowed_tools, vec!["Bash", "Write"]);
        assert_eq!(ext.isolation, "sandbox");
        assert!(p.system_prompt.contains("meticulous researcher"));
    }

    #[test]
    fn render_roundtrip_is_claude_compatible() {
        let (p, ext) = parse_agent_md(SAMPLE).unwrap();
        let profile = AgentProfile {
            id: "ag_test".into(),
            name: p.name.clone(),
            model: p.model.clone(),
            system_prompt: p.system_prompt.clone(),
            capabilities: vec![],
            skills: vec![],
            mcp: vec![],
            tools: p.tools.clone(),
            plugins: vec![],
            created_at: 0,
            token_budget: 100_000,
            provider: default_provider(),
            executor: None,
            disallowed_tools: ext.disallowed_tools.clone(),
            permission_mode: ext.permission_mode.clone(),
            max_turns: ext.max_turns,
            isolation: ext.isolation.clone(),
        };
        let md = render_agent_md(&profile, false);
        
        let (p2, ext2) = parse_agent_md(&md).expect("re-parse ok");
        assert_eq!(p2.name, "researcher");
        assert_eq!(p2.tools, vec!["Read", "Grep", "Glob", "WebFetch"]);
        assert_eq!(ext2.permission_mode, "plan");
        assert_eq!(ext2.max_turns, 20);
        assert_eq!(ext2.disallowed_tools, vec!["Bash", "Write"]);
    }

    #[test]
    fn redact_hides_system_prompt() {
        let profile = AgentProfile {
            id: "ag_r".into(),
            name: "x".into(),
            model: "deepseek-chat".into(),
            system_prompt: "SECRET_PROMPT".into(),
            capabilities: vec![],
            skills: vec![],
            mcp: vec![],
            tools: vec![],
            plugins: vec![],
            created_at: 0,
            token_budget: 100_000,
            provider: default_provider(),
            executor: None,
            disallowed_tools: vec![],
            permission_mode: "default".into(),
            max_turns: 0,
            isolation: "none".into(),
        };
        let md = render_agent_md(&profile, true);
        assert!(md.contains("[REDACTED system prompt]"));
        assert!(!md.contains("SECRET_PROMPT"));
    }

    #[test]
    fn missing_name_errors() {
        let bad = "---\ndescription: no name\n---\nbody\n";
        assert!(parse_agent_md(bad).is_err());
    }
}

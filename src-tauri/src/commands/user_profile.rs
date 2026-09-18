























use crate::agent::tools::memory::user_memory_path;

const BEGIN_MARKER: &str = "<!-- onedesktop:profile:begin -->";
const END_MARKER: &str = "<!-- onedesktop:profile:end -->";





fn extract_section(full: &str) -> Option<&str> {
    let start = full.find(BEGIN_MARKER)?;
    let body_start = start + BEGIN_MARKER.len();
    let end = full[body_start..].find(END_MARKER)? + body_start;
    Some(full[body_start..end].trim_matches('\n'))
}




fn upsert_section(full: &str, section: &str) -> String {
    let section = section.trim();

    
    if let (Some(start), Some(end_idx)) = (full.find(BEGIN_MARKER), full.find(END_MARKER)) {
        if end_idx > start {
            let head = &full[..start];
            let tail = &full[end_idx + END_MARKER.len()..];
            if section.is_empty() {
                let merged = format!("{}{}", head.trim_end(), tail);
                return normalize_tail(&merged);
            }
            let merged = format!(
                "{}{}\n{}\n{}{}",
                head, BEGIN_MARKER, section, END_MARKER, tail
            );
            return normalize_tail(&merged);
        }
    }

    if section.is_empty() {
        return normalize_tail(full);
    }

    
    let mut out = full.trim_end().to_string();
    if !out.is_empty() {
        out.push_str("\n\n");
    }
    out.push_str(BEGIN_MARKER);
    out.push('\n');
    out.push_str(section);
    out.push('\n');
    out.push_str(END_MARKER);
    normalize_tail(&out)
}


fn normalize_tail(s: &str) -> String {
    let mut out = s.trim_end().to_string();
    out.push('\n');
    out
}


#[tauri::command]
pub fn user_profile_read() -> Result<String, String> {
    let path = user_memory_path();
    let full = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return Ok(String::new()),
    };
    Ok(extract_section(&full).unwrap_or("").to_string())
}


#[tauri::command]
pub fn user_profile_write(section: String) -> Result<(), String> {
    let path = user_memory_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建记忆目录失败: {}", e))?;
    }
    let full = std::fs::read_to_string(&path).unwrap_or_default();
    let next = upsert_section(&full, &section);
    std::fs::write(&path, next).map_err(|e| format!("写入 {} 失败: {}", path.display(), e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upsert_appends_when_absent() {
        let out = upsert_section("# User Profile\n\n- agent 记的事实\n", "- 称呼：Eddie");
        assert!(out.contains("- agent 记的事实"));
        assert!(out.contains(BEGIN_MARKER));
        assert_eq!(extract_section(&out), Some("- 称呼：Eddie"));
    }

    #[test]
    fn upsert_replaces_in_place_and_keeps_neighbors() {
        let first = upsert_section("# User Profile\n", "- 称呼：Eddie");
        
        let with_agent = format!("{}\n- agent 后来记的\n", first.trim_end());
        let second = upsert_section(&with_agent, "- 称呼：老张");

        assert_eq!(extract_section(&second), Some("- 称呼：老张"));
        assert!(second.contains("- agent 后来记的"), "相邻内容必须保留");
        assert!(!second.contains("Eddie"), "旧画像应被替换而非叠加");
        assert_eq!(second.matches(BEGIN_MARKER).count(), 1, "哨兵不得重复");
    }

    #[test]
    fn empty_section_removes_block() {
        let first = upsert_section("# User Profile\n", "- 称呼：Eddie");
        let cleared = upsert_section(&first, "   ");
        assert!(!cleared.contains(BEGIN_MARKER));
        assert!(cleared.contains("# User Profile"));
        assert_eq!(extract_section(&cleared), None);
    }

    #[test]
    fn extract_returns_none_on_broken_markers() {
        assert_eq!(extract_section("no markers at all"), None);
        
        assert_eq!(extract_section(&format!("{}\n- x\n", BEGIN_MARKER)), None);
    }

    #[test]
    fn repeated_writes_do_not_grow_blank_lines() {
        let mut cur = String::from("# User Profile\n");
        for _ in 0..5 {
            cur = upsert_section(&cur, "- 称呼：Eddie");
        }
        assert!(!cur.contains("\n\n\n"), "结尾空白应被收敛");
        assert_eq!(cur.matches(BEGIN_MARKER).count(), 1);
    }
}






























use std::path::PathBuf;


const APP_DIR: &str = ".one-desktop";


pub fn data_dir() -> PathBuf {
    dirs::home_dir()
        .expect("Cannot find home directory")
        .join(APP_DIR)
}


pub fn db_dir() -> PathBuf {
    data_dir().join("db")
}


pub fn logs_dir() -> PathBuf {
    data_dir().join("logs")
}


pub fn memory_dir() -> PathBuf {
    data_dir().join("memory")
}


pub fn skills_dir() -> PathBuf {
    data_dir().join("skills")
}


pub fn mcp_dir() -> PathBuf {
    data_dir().join("mcp")
}


pub fn cache_dir() -> PathBuf {
    data_dir().join("cache")
}


pub fn tmp_dir() -> PathBuf {
    data_dir().join("tmp")
}




pub fn session_tmp_root(session_id: &str) -> PathBuf {
    tmp_dir().join(sanitize_component(session_id))
}


fn sanitize_component(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}


pub fn skill_dir(source: &str, id: &str) -> PathBuf {
    skills_dir().join(source).join(id)
}


pub fn mcp_server_dir(id: &str) -> PathBuf {
    mcp_dir().join(id)
}


pub fn ensure_dirs() {
    for dir in [
        data_dir(),
        db_dir(),
        logs_dir(),
        memory_dir(),
        skills_dir(),
        mcp_dir(),
        cache_dir(),
        tmp_dir(),
    ] {
        let _ = std::fs::create_dir_all(&dir);
    }
}








pub fn migrate_legacy() {
    let root = data_dir();

    let legacy_db = root.join("onedesktop.db");
    let new_db = db_dir().join("onedesktop.db");
    if legacy_db.exists() && !new_db.exists() {
        
        
        for suffix in ["", "-wal", "-shm"] {
            let src = root.join(format!("onedesktop.db{}", suffix));
            let dst = db_dir().join(format!("onedesktop.db{}", suffix));
            if src.exists() && !dst.exists() {
                let _ = std::fs::rename(&src, &dst);
            }
        }
    }

    for name in ["USER.md", "MEMORY.md"] {
        let legacy = root.join(name);
        let new_path = memory_dir().join(name);
        if legacy.exists() && !new_path.exists() {
            let _ = std::fs::rename(&legacy, &new_path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_tmp_root_is_under_tmp_and_sanitized() {
        let p = session_tmp_root("sess-123");
        assert_eq!(p, data_dir().join("tmp").join("sess-123"));
        
        let evil = session_tmp_root("../../etc/passwd");
        assert!(!evil.components().any(|c| c.as_os_str() == ".."), "不允许穿越: {:?}", evil);
        assert!(evil.starts_with(tmp_dir()), "必须落在 tmp/ 下");
    }

    #[test]
    fn session_tmp_root_matches_tmp_dir_prefix() {
        let p = session_tmp_root("abc");
        assert!(p.starts_with(tmp_dir()), "会话临时目录必须是 tmp/ 的子目录");
    }
}


















use std::path::PathBuf;

use crate::paths;



fn sanitize_id(id: &str) -> String {
    id.replace(['/', '\\', ':', '.', ' '], "_")
}

pub struct WorkspaceManager {
    base: PathBuf,
}

impl Default for WorkspaceManager {
    fn default() -> Self {
        Self::new()
    }
}

impl WorkspaceManager {
    pub fn new() -> Self {
        let base = paths::data_dir().join("workspaces");
        let _ = std::fs::create_dir_all(&base);
        Self { base }
    }

    
    pub fn root_for(&self, group_id: &str, worker_id: Option<&str>) -> PathBuf {
        match worker_id {
            Some(w) => self.base.join(sanitize_id(group_id)).join(sanitize_id(w)),
            None => self.base.join(sanitize_id(group_id)),
        }
    }

    
    pub fn ensure(&self, group_id: &str, worker_id: Option<&str>) -> Result<PathBuf, String> {
        let p = self.root_for(group_id, worker_id);
        std::fs::create_dir_all(&p)
            .map_err(|e| format!("Failed to create workspace dir {}: {}", p.display(), e))?;
        Ok(p)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn group_root_is_base_join_group_id() {
        
        let wm = WorkspaceManager::new();
        let p = wm.root_for("grp_be706167", None);
        assert_eq!(p.file_name().unwrap(), "grp_be706167");
        assert_eq!(p.parent().unwrap(), wm.base);
    }

    #[test]
    fn per_worker_subdir_is_group_join_worker() {
        
        
        let wm = WorkspaceManager::new();
        let p = wm.root_for("grp_be706167", Some("wk_123"));
        assert_eq!(p.parent().unwrap().file_name().unwrap(), "grp_be706167");
        assert_eq!(p.file_name().unwrap(), "wk_123");
    }

    #[test]
    fn ensure_creates_group_root() {
        
        let wm = WorkspaceManager::new();
        let p = wm.ensure("grp_test_root", None).unwrap();
        assert!(p.exists());
        assert_eq!(p.file_name().unwrap(), "grp_test_root");
        let _ = std::fs::remove_dir_all(&p);
    }
}

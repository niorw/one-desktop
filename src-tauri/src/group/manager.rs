




use crate::group::agent_repo::AgentProfileRepository;
use crate::group::group_repo::GroupRepository;
use crate::group::manifest::GroupManifest;
use crate::group::worker::{Worker, WorkerPool, WorkerStatus};
use crate::group::worker_repo::WorkerRepository;
use crate::group::{CreateGroupPayload, Group, GroupKind, GroupListItem, GroupStatus, SeatType};
use crate::storage::connection::DbConnection;
use crate::storage::repository::Repository;
use std::sync::Arc;

pub struct GroupManager {
    db: Arc<DbConnection>,
}

impl GroupManager {
    pub fn new(db: Arc<DbConnection>) -> Self {
        Self { db }
    }

    
    
    pub fn create_group(&self, p: CreateGroupPayload) -> Result<Group, String> {
        if p.name.trim().is_empty() {
            return Err("name is required".into());
        }
        if p.owner_agent_ref.trim().is_empty() {
            return Err("owner_agent_ref is required".into());
        }
        let repo = GroupRepository::new(&self.db);
        let group = repo.create(p).map_err(|e| e.to_string())?;
        self.spawn_static_seats(&group);
        Ok(group)
    }

    
    
    
    
    pub fn create_group_from_manifest(&self, m: &GroupManifest) -> Result<Group, String> {
        if m.name.trim().is_empty() {
            return Err("name is required".into());
        }
        let owner = m
            .owner_agent_ref
            .clone()
            .ok_or_else(|| "owner_agent_ref is required".to_string())?;
        if owner.trim().is_empty() {
            return Err("owner_agent_ref is required".into());
        }
        let payload = CreateGroupPayload {
            name: m.name.clone(),
            goal: m.goal.clone(),
            owner_agent_ref: owner,
            seat_config: m.to_seat_config(),
            kind: GroupKind::Chat,
        };
        let repo = GroupRepository::new(&self.db);
        let group = repo
            .create_with_topology(&payload, &m.topology)
            .map_err(|e| e.to_string())?;
        self.spawn_static_seats(&group);
        Ok(group)
    }

    
    
    fn spawn_static_seats(&self, group: &Group) {
        let pool = WorkerPool::new(group.id.clone(), self.db.clone());
        let agent_repo = AgentProfileRepository::new(self.db.as_ref());
        if let Some(arr) = group.seat_config.get("static").and_then(|v| v.as_array()) {
            for v in arr {
                if let Some(agent_ref) = v.as_str() {
                    if let Ok(Some(profile)) = agent_repo.find_by_id(agent_ref) {
                        let _ = pool.register(agent_ref, SeatType::Static, profile.capabilities, 1);
                    }
                }
            }
        }
    }

    pub fn list_groups(&self) -> Result<Vec<GroupListItem>, String> {
        let repo = GroupRepository::new(&self.db);
        repo.find_summaries().map_err(|e| e.to_string())
    }

    pub fn get_group(&self, id: &str) -> Result<Option<Group>, String> {
        let repo = GroupRepository::new(&self.db);
        repo.find_by_id(id).map_err(|e| e.to_string())
    }

    
    pub fn pause(&self, id: &str) -> Result<(), String> {
        let repo = GroupRepository::new(&self.db);
        let g = repo
            .find_by_id(id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "group not found".to_string())?;
        match g.status {
            GroupStatus::Active => repo
                .update_status(id, GroupStatus::Paused)
                .map_err(|e| e.to_string()),
            other => Err(format!("cannot pause group in {:?} state", other)),
        }
    }

    
    pub fn resume(&self, id: &str) -> Result<(), String> {
        let repo = GroupRepository::new(&self.db);
        let g = repo
            .find_by_id(id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "group not found".to_string())?;
        match g.status {
            GroupStatus::Paused => repo
                .update_status(id, GroupStatus::Active)
                .map_err(|e| e.to_string()),
            other => Err(format!("cannot resume group in {:?} state", other)),
        }
    }

    
    pub fn dissolve(&self, id: &str) -> Result<(), String> {
        let repo = GroupRepository::new(&self.db);
        let g = repo
            .find_by_id(id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "group not found".to_string())?;
        match g.status {
            GroupStatus::Active | GroupStatus::Paused => repo
                .update_status(id, GroupStatus::Archiving)
                .map_err(|e| e.to_string()),
            other => Err(format!("cannot dissolve group in {:?} state", other)),
        }
    }

    
    
    
    
    pub fn add_worker(
        &self,
        group_id: &str,
        agent_ref: &str,
        capabilities: Vec<String>,
        max_concurrency: i32,
    ) -> Result<Worker, String> {
        let pool = WorkerPool::new(group_id.to_string(), self.db.clone());
        if capabilities.is_empty() {
            pool.add_at_runtime(agent_ref)
        } else {
            pool.register(agent_ref, SeatType::Dynamic, capabilities, max_concurrency)
        }
    }

    
    
    
    pub fn add_capability_seat(
        &self,
        group_id: &str,
        capabilities: Vec<String>,
        max_concurrency: i32,
    ) -> Result<Worker, String> {
        let pool = WorkerPool::new(group_id.to_string(), self.db.clone());
        let w = pool
            .register("", SeatType::Capability, capabilities, max_concurrency)
            .map_err(|e| e.to_string())?;
        let repo = WorkerRepository::new(self.db.as_ref());
        repo.update_status(&w.id, WorkerStatus::Offline)
            .map_err(|e| e.to_string())?;
        Ok(Worker {
            status: WorkerStatus::Offline,
            ..w
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::group::agent_profile::CreateAgentProfilePayload;
    use crate::group::agent_repo::AgentProfileRepository;
    use crate::group::worker::WorkerStatus;
    use crate::storage::connection::DbConnection;
    use std::path::PathBuf;

    fn tmp_db() -> DbConnection {
        let dir = PathBuf::from(std::env::temp_dir())
            .join(format!("od_grp_{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).ok();
        DbConnection::open(&dir).unwrap()
    }

    #[test]
    fn create_group_yields_active() {
        let mgr = GroupManager::new(Arc::new(tmp_db()));
        let g = mgr
            .create_group(CreateGroupPayload {
                name: "research-squad".into(),
                goal: "write a report".into(),
                owner_agent_ref: "ag_owner".into(),
                seat_config: serde_json::json!({"static": ["ag_w1"]}),
                kind: GroupKind::Chat,
            })
            .unwrap();
        assert_eq!(g.status, GroupStatus::Active);
        assert!(g.id.starts_with("grp_"));
        assert_eq!(g.goal, "write a report");
    }

    #[test]
    fn pause_resume_dissolve_state_machine() {
        let mgr = GroupManager::new(Arc::new(tmp_db()));
        let g = mgr
            .create_group(CreateGroupPayload {
                name: "s".into(),
                goal: "g".into(),
                owner_agent_ref: "ag_owner".into(),
                seat_config: serde_json::Value::Null,
                kind: GroupKind::Chat,
            })
            .unwrap();

        mgr.pause(&g.id).unwrap();
        assert_eq!(
            mgr.get_group(&g.id).unwrap().unwrap().status,
            GroupStatus::Paused
        );
        
        assert!(mgr.pause(&g.id).is_err());

        mgr.resume(&g.id).unwrap();
        assert_eq!(
            mgr.get_group(&g.id).unwrap().unwrap().status,
            GroupStatus::Active
        );

        mgr.dissolve(&g.id).unwrap();
        assert_eq!(
            mgr.get_group(&g.id).unwrap().unwrap().status,
            GroupStatus::Archiving
        );
    }

    #[test]
    fn add_worker_registers_dynamic_seat_from_catalog() {
        let db = Arc::new(tmp_db());
        let agent = AgentProfileRepository::new(db.as_ref())
            .create(CreateAgentProfilePayload {
                name: "writer".into(),
                model: "deepseek-chat".into(),
                system_prompt: "x".into(),
                capabilities: vec!["write".into()],
                skills: vec![],
                mcp: vec![],
                tools: vec!["fs".into()],
            })
            .unwrap();

        let mgr = GroupManager::new(db.clone());
        let w = mgr.add_worker("grp_t", &agent.id, vec![], 1).unwrap();
        assert_eq!(w.seat_type, SeatType::Dynamic);
        assert_eq!(w.status, WorkerStatus::Idle);
        assert_eq!(w.group_id, "grp_t");
    }
}





use crate::group::agent_repo::AgentProfileRepository;
use crate::group::worker_repo::WorkerRepository;
use crate::group::SeatType;
use crate::storage::connection::DbConnection;
use crate::storage::repository::Repository;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum WorkerStatus {
    Idle,
    Busy,
    Offline,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Worker {
    pub id: String,
    pub group_id: String,
    pub agent_ref: String,
    pub seat_type: SeatType,
    pub status: WorkerStatus,
    pub max_concurrency: i32,
    pub capabilities: Vec<String>,
    pub current_task_id: Option<String>,
    pub last_heartbeat: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct CreateWorkerPayload {
    pub group_id: String,
    pub agent_ref: String,
    pub seat_type: SeatType,
    pub capabilities: Vec<String>,
    pub max_concurrency: i32,
}



pub fn worker_session_id(group_id: &str, worker_id: &str) -> String {
    format!("{}:{}", group_id, worker_id)
}






pub struct WorkerPool {
    group_id: String,
    db: Arc<DbConnection>,
}

impl WorkerPool {
    pub fn new(group_id: String, db: Arc<DbConnection>) -> Self {
        Self { group_id, db }
    }

    
    pub fn register(
        &self,
        agent_ref: &str,
        seat_type: SeatType,
        capabilities: Vec<String>,
        max_concurrency: i32,
    ) -> Result<Worker, String> {
        let repo = WorkerRepository::new(&self.db);
        repo.create(CreateWorkerPayload {
            group_id: self.group_id.clone(),
            agent_ref: agent_ref.to_string(),
            seat_type,
            capabilities,
            max_concurrency,
        })
        .map_err(|e| e.to_string())
    }

    
    pub fn add_at_runtime(&self, agent_ref: &str) -> Result<Worker, String> {
        let agent_repo = AgentProfileRepository::new(&self.db);
        let profile = agent_repo
            .find_by_id(agent_ref)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("agent preset {} not found", agent_ref))?;
        self.register(agent_ref, SeatType::Dynamic, profile.capabilities, 1)
    }

    
    
    
    
    pub fn set_agent(&self, worker_id: &str, agent_ref: &str) -> Result<Worker, String> {
        let repo = WorkerRepository::new(&self.db);
        let w = repo
            .find_by_id(worker_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "worker not found".to_string())?;
        if w.group_id != self.group_id {
            return Err("worker does not belong to this group".into());
        }
        let agent_repo = AgentProfileRepository::new(&self.db);
        let profile = agent_repo
            .find_by_id(agent_ref)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("agent preset {} not found", agent_ref))?;
        repo.update_agent(worker_id, agent_ref, &profile.capabilities)
            .map_err(|e| e.to_string())?;
        repo.find_by_id(worker_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "worker not found after re-bind".to_string())
    }

    
    pub fn pick(&self, need: &[String]) -> Result<Option<Worker>, String> {
        let repo = WorkerRepository::new(&self.db);
        let workers = repo
            .list_by_group(&self.group_id)
            .map_err(|e| e.to_string())?;
        Ok(workers
            .into_iter()
            .filter(|w| w.status == WorkerStatus::Idle)
            .find(|w| need.iter().all(|n| w.capabilities.iter().any(|c| c == n))))
    }

    
    pub fn match_by_capability(&self, need: &[String]) -> Result<Option<Worker>, String> {
        self.pick(need)
    }

    
    
    
    
    
    
    pub fn acquire(&self, worker_id: &str, task_id: &str) -> Result<(), String> {
        let repo = WorkerRepository::new(&self.db);
        if let Ok(Some(w)) = repo.find_by_id(worker_id) {
            if w.status == WorkerStatus::Busy {
                return Err(format!(
                    "worker {} is busy (max_concurrency={}); concurrent engine run denied",
                    worker_id, w.max_concurrency
                ));
            }
        }
        repo.update_status(worker_id, WorkerStatus::Busy)
            .map_err(|e| e.to_string())?;
        repo.update_current_task(worker_id, Some(task_id.to_string()))
            .map_err(|e| e.to_string())
    }

    
    pub fn release(&self, worker_id: &str) -> Result<(), String> {
        let repo = WorkerRepository::new(&self.db);
        repo.release(worker_id).map_err(|e| e.to_string())?;
        repo.update_current_task(worker_id, None)
            .map_err(|e| e.to_string())
    }

    pub fn list(&self) -> Result<Vec<Worker>, String> {
        let repo = WorkerRepository::new(&self.db);
        repo.list_by_group(&self.group_id)
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::group::agent_profile::CreateAgentProfilePayload;
    use crate::group::agent_repo::AgentProfileRepository;
    use crate::storage::connection::DbConnection;
    use std::path::PathBuf;
    use std::sync::Arc;

    fn tmp_db() -> DbConnection {
        let dir = PathBuf::from(std::env::temp_dir())
            .join(format!("od_pool_{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).ok();
        DbConnection::open(&dir).unwrap()
    }

    fn seed_agent(db: &DbConnection, tag: &str, caps: Vec<String>) -> String {
        let repo = AgentProfileRepository::new(db);
        repo.create(CreateAgentProfilePayload {
            name: format!("ag-{}", tag),
            model: "deepseek-chat".into(),
            system_prompt: "x".into(),
            capabilities: caps,
            skills: vec![],
            mcp: vec![],
            tools: vec!["fs".into()],
        })
        .unwrap()
        .id
    }

    #[test]
    fn three_seat_types_and_pick() {
        let db = Arc::new(tmp_db());
        let ag_research = seed_agent(&db, "research", vec!["search".into(), "summarize".into()]);
        let ag_writer = seed_agent(&db, "writer", vec!["write".into()]);

        let pool = WorkerPool::new("grp_x".into(), db.clone());
        
        let w1 = pool
            .register(
                &ag_research,
                SeatType::Static,
                vec!["search".into(), "summarize".into()],
                1,
            )
            .unwrap();
        
        let w2 = pool.add_at_runtime(&ag_writer).unwrap();
        assert_eq!(w2.seat_type, SeatType::Dynamic);

        
        let picked = pool.pick(&["search".into()]).unwrap();
        assert_eq!(picked.unwrap().id, w1.id);

        
        pool.acquire(&w1.id, "task_1").unwrap();
        assert!(pool.pick(&["search".into()]).unwrap().is_none());

        
        pool.release(&w1.id).unwrap();
        assert_eq!(pool.pick(&["search".into()]).unwrap().unwrap().id, w1.id);
    }

    #[test]
    fn set_agent_rebinds_and_syncs_caps() {
        let db = Arc::new(tmp_db());
        let ag_a = seed_agent(&db, "A", vec!["search".into()]);
        let ag_b = seed_agent(&db, "B", vec!["write".into(), "edit".into()]);
        let pool = WorkerPool::new("grp_rb".into(), db.clone());
        let w = pool.add_at_runtime(&ag_a).unwrap();

        
        let updated = pool.set_agent(&w.id, &ag_b).unwrap();
        assert_eq!(updated.agent_ref, ag_b);
        assert_eq!(updated.capabilities, vec!["write".to_string(), "edit".to_string()]);

        
        assert!(pool.set_agent(&w.id, "nope").is_err());
    }

    #[test]
    fn capability_seat_routing_and_autofill() {
        let db = Arc::new(tmp_db());
        let ag = seed_agent(&db, "filler", vec!["cap".into(), "x".into()]);
        let pool = WorkerPool::new("grp_cap".into(), db.clone());
        
        let seat = pool
            .register("", SeatType::Capability, vec!["cap".into()], 1)
            .unwrap();
        assert!(seat.agent_ref.is_empty());
        
        let picked = pool.pick(&["cap".into()]).unwrap();
        assert_eq!(picked.unwrap().id, seat.id);
        
        let filled = pool.set_agent(&seat.id, &ag).unwrap();
        assert_eq!(filled.agent_ref, ag);
        assert_eq!(filled.capabilities, vec!["cap".to_string(), "x".to_string()]);
    }
}

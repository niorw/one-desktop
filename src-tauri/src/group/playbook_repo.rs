












use crate::storage::connection::DbConnection;
use rusqlite::{params, Result as SqliteResult};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PlaybookStep {
    pub description: String,
    
    #[serde(default)]
    pub depends_on: Vec<usize>,
    #[serde(default)]
    pub capability: Option<String>,
    #[serde(default)]
    pub reasoning: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Playbook {
    pub id: String,
    pub name: String,
    pub steps: Vec<PlaybookStep>,
    pub success_criteria: Option<String>,
    pub guardrails: Option<String>,
    
    pub source_run_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct SavePlaybookPayload {
    pub name: String,
    pub steps: Vec<PlaybookStep>,
    #[serde(default)]
    pub success_criteria: Option<String>,
    #[serde(default)]
    pub guardrails: Option<String>,
    #[serde(default)]
    pub source_run_id: Option<String>,
}

pub struct PlaybookRepository<'a> {
    db: &'a DbConnection,
}

impl<'a> PlaybookRepository<'a> {
    pub fn new(db: &'a DbConnection) -> Self {
        Self { db }
    }

    pub fn list(&self) -> SqliteResult<Vec<Playbook>> {
        self.db.with_conn(|c| {
            let mut stmt = c.prepare(
                "SELECT id, name, steps, success_criteria, guardrails, source_run_id, created_at, updated_at \
                 FROM playbooks ORDER BY updated_at DESC",
            )?;
            let rows = stmt
                .query_map([], |r| row_to_playbook(r))?
                .filter_map(|r| r.ok())
                .collect();
            Ok(rows)
        })
    }

    pub fn get(&self, id: &str) -> SqliteResult<Option<Playbook>> {
        self.db.with_conn(|c| {
            let mut stmt = c.prepare(
                "SELECT id, name, steps, success_criteria, guardrails, source_run_id, created_at, updated_at \
                 FROM playbooks WHERE id = ?1",
            )?;
            let mut rows = stmt.query_map(params![id], row_to_playbook)?;
            match rows.next() {
                Some(Ok(p)) => Ok(Some(p)),
                _ => Ok(None),
            }
        })
    }

    pub fn save(&self, p: SavePlaybookPayload) -> SqliteResult<Playbook> {
        let now = chrono::Utc::now().to_rfc3339();
        let id = uuid::Uuid::new_v4().to_string();
        let steps_json = serde_json::to_string(&p.steps).unwrap_or_else(|_| "[]".to_string());
        let book = Playbook {
            id: id.clone(),
            name: p.name.trim().to_string(),
            steps: p.steps,
            success_criteria: p.success_criteria,
            guardrails: p.guardrails,
            source_run_id: p.source_run_id,
            created_at: now.clone(),
            updated_at: now,
        };
        self.db.with_conn_mut(|c| {
            c.execute(
                "INSERT INTO playbooks (id, name, steps, success_criteria, guardrails, source_run_id, created_at, updated_at) \
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                params![
                    book.id,
                    book.name,
                    steps_json,
                    book.success_criteria,
                    book.guardrails,
                    book.source_run_id,
                    book.created_at,
                    book.updated_at,
                ],
            )
            .map(|_| ())
        })?;
        Ok(book)
    }

    pub fn delete(&self, id: &str) -> SqliteResult<()> {
        self.db
            .with_conn_mut(|c| c.execute("DELETE FROM playbooks WHERE id = ?1", params![id]).map(|_| ()))
    }
}

fn row_to_playbook(row: &rusqlite::Row) -> rusqlite::Result<Playbook> {
    let steps_json: String = row.get(2)?;
    let steps: Vec<PlaybookStep> = serde_json::from_str(&steps_json).unwrap_or_default();
    Ok(Playbook {
        id: row.get(0)?,
        name: row.get(1)?,
        steps,
        success_criteria: row.get(3)?,
        guardrails: row.get(4)?,
        source_run_id: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_db(name: &str) -> DbConnection {
        let dir = std::env::temp_dir().join(format!("od_f9_{}_{}", std::process::id(), name));
        std::fs::create_dir_all(&dir).unwrap();
        DbConnection::open(&dir).unwrap()
    }

    #[test]
    fn playbook_save_list_get_delete_roundtrip() {
        let db = tmp_db("roundtrip");
        let repo = PlaybookRepository::new(&db);
        let saved = repo
            .save(SavePlaybookPayload {
                name: "竞品调研 → 方案评审".into(),
                steps: vec![
                    PlaybookStep {
                        description: "调研竞品 A/B".into(),
                        depends_on: vec![],
                        capability: Some("research".into()),
                        reasoning: None,
                    },
                    PlaybookStep {
                        description: "基于调研结论评审方案".into(),
                        depends_on: vec![0],
                        capability: Some("review".into()),
                        reasoning: Some("先有调研才有评审依据".into()),
                    },
                ],
                success_criteria: Some("方案有明确取舍与风险清单".into()),
                guardrails: None,
                source_run_id: Some("run-abc".into()),
            })
            .unwrap();

        let list = repo.list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "竞品调研 → 方案评审");

        let got = repo.get(&saved.id).unwrap().unwrap();
        assert_eq!(got.steps.len(), 2);
        assert_eq!(got.steps[1].depends_on, vec![0]);
        assert_eq!(got.source_run_id.as_deref(), Some("run-abc"));

        repo.delete(&saved.id).unwrap();
        assert!(repo.get(&saved.id).unwrap().is_none());
    }

    #[test]
    fn save_validates_non_empty_name() {
        let db = tmp_db("name");
        let repo = PlaybookRepository::new(&db);
        
        let p = repo
            .save(SavePlaybookPayload {
                name: "  ".into(),
                steps: vec![],
                success_criteria: None,
                guardrails: None,
                source_run_id: None,
            })
            .unwrap();
        assert!(p.name.is_empty());
        assert_eq!(repo.list().unwrap().len(), 1);
    }
}

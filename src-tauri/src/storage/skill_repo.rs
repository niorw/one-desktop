

use crate::skill::model::*;
use crate::storage::connection::DbConnection;
use crate::storage::repository::Repository;
use rusqlite::{params, Result as SqliteResult};
use serde_json;

pub struct SkillRepository<'a> {
    db: &'a DbConnection,
}

impl<'a> SkillRepository<'a> {
    pub fn new(db: &'a DbConnection) -> Self {
        Self { db }
    }

    pub fn set_enabled(&self, id: &str, enabled: bool) -> SqliteResult<()> {
        let now = chrono::Utc::now().to_rfc3339();
        let status = if enabled {
            SkillStatus::Enabled
        } else {
            SkillStatus::Disabled
        };
        self.db.with_conn_mut(|c| {
            c.execute(
                "UPDATE skills SET status=?1, updated_at=?2 WHERE id=?3",
                params![status.as_str(), now, id],
            )
            .map(|_| ())
        })
    }
}

impl<'a> Repository<Skill, CreateSkillPayload, ()> for SkillRepository<'a> {
    fn create(&self, p: CreateSkillPayload) -> SqliteResult<Skill> {
        let now = chrono::Utc::now().to_rfc3339();
        let deps_json = serde_json::to_string(&p.dependencies).unwrap_or_else(|_| "[]".to_string());
        let skill = Skill {
            id: p.id,
            name: p.name,
            description: p.description,
            version: p.version,
            source: p.source,
            path: p.path,
            url: p.url,
            status: p.status,
            dependencies: p.dependencies,
            created_at: now.clone(),
            updated_at: now,
        };
        self.db.with_conn_mut(|c| {
            c.execute(
                "INSERT INTO skills \
                 (id,name,description,version,source,path,url,status,dependencies,created_at,updated_at) \
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
                params![
                    skill.id,
                    skill.name,
                    skill.description,
                    skill.version,
                    skill.source.as_str(),
                    skill.path,
                    skill.url,
                    skill.status.as_str(),
                    deps_json,
                    skill.created_at,
                    skill.updated_at,
                ],
            )
            .map(|_| ())
        })?;
        Ok(skill)
    }

    fn find_by_id(&self, id: &str) -> SqliteResult<Option<Skill>> {
        self.db.with_conn(|c| {
            let mut stmt = c.prepare(
                "SELECT id,name,description,version,source,path,url,status,dependencies,created_at,updated_at \
                 FROM skills WHERE id=?1",
            )?;
            let mut rows = stmt.query_map(params![id], row_to_skill)?;
            match rows.next() {
                Some(Ok(s)) => Ok(Some(s)),
                _ => Ok(None),
            }
        })
    }

    fn find_all(&self, _q: ()) -> SqliteResult<Vec<Skill>> {
        self.db.with_conn(|c| {
            let mut stmt = c.prepare(
                "SELECT id,name,description,version,source,path,url,status,dependencies,created_at,updated_at \
                 FROM skills ORDER BY updated_at DESC",
            )?;
            let list = stmt
                .query_map([], row_to_skill)?
                .filter_map(|r| r.ok())
                .collect();
            Ok(list)
        })
    }

    fn delete(&self, id: &str) -> SqliteResult<()> {
        self.db.with_conn_mut(|c| {
            c.execute("DELETE FROM skills WHERE id=?1", params![id])
                .map(|_| ())
        })
    }
}

fn row_to_skill(row: &rusqlite::Row) -> rusqlite::Result<Skill> {
    let deps_json: String = row.get(8)?;
    let dependencies: Vec<String> = serde_json::from_str(&deps_json).unwrap_or_default();
    Ok(Skill {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        version: row.get(3)?,
        source: SkillSource::from_str(&row.get::<_, String>(4)?),
        path: row.get(5)?,
        url: row.get(6)?,
        status: SkillStatus::from_str(&row.get::<_, String>(7)?),
        dependencies,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

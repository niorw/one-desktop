

use crate::skill::budget::{SkillBudget, SkillBudgetTracker, SkillUsage};
use crate::storage::connection::DbConnection;
use rusqlite::{params, Result as SqliteResult};
use std::sync::Arc;


pub struct SqliteSkillBudgetTracker {
    db: Arc<DbConnection>,
}

impl SqliteSkillBudgetTracker {
    pub fn new(db: Arc<DbConnection>) -> Self {
        Self { db }
    }
}

impl SkillBudgetTracker for SqliteSkillBudgetTracker {
    fn get_budget(&self, skill_id: &str) -> SkillBudget {
        self.db
            .with_conn(|conn| -> SqliteResult<SkillBudget> {
                let row: Option<(Option<i64>, Option<i64>, Option<i64>)> = conn
                    .query_row(
                        "SELECT token_limit, cost_cents_limit, time_secs_limit \
                         FROM skill_budgets WHERE skill_id = ?1",
                        params![skill_id],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                    )
                    .ok();
                Ok(match row {
                    Some((t, c, tm)) => SkillBudget {
                        token_limit: t.map(|v| v as u64),
                        cost_cents_limit: c.map(|v| v as u64),
                        time_secs_limit: tm.map(|v| v as u64),
                    },
                    None => SkillBudget::default(),
                })
            })
            .unwrap_or_default()
    }

    fn get_usage(&self, run_id: &str, skill_id: &str) -> SkillUsage {
        self.db
            .with_conn(|conn| -> SqliteResult<SkillUsage> {
                let row: Option<(i64, i64, i64)> = conn
                    .query_row(
                        "SELECT tokens, cost_cents, elapsed_ms \
                         FROM skill_budget_usage WHERE run_id = ?1 AND skill_id = ?2",
                        params![run_id, skill_id],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                    )
                    .ok();
                Ok(match row {
                    Some((t, c, e)) => SkillUsage {
                        tokens: t as u64,
                        cost_cents: c as u64,
                        elapsed_ms: e as u64,
                    },
                    None => SkillUsage::default(),
                })
            })
            .unwrap_or_default()
    }

    fn set_budget(&self, skill_id: &str, b: &SkillBudget) -> Result<(), String> {
        self.db
            .with_conn_mut(|conn| {
                conn.execute(
                    "INSERT INTO skill_budgets \
                     (skill_id, token_limit, cost_cents_limit, time_secs_limit, version) \
                     VALUES (?1,?2,?3,?4,1) \
                     ON CONFLICT(skill_id) DO UPDATE SET \
                       token_limit=?2, cost_cents_limit=?3, time_secs_limit=?4, version=version+1",
                    params![
                        skill_id,
                        b.token_limit.map(|v| v as i64),
                        b.cost_cents_limit.map(|v| v as i64),
                        b.time_secs_limit.map(|v| v as i64),
                    ],
                )
            })
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    fn record_usage(&self, run_id: &str, skill_id: &str, inc: &SkillUsage) -> Result<(), String> {
        self.db
            .with_conn_mut(|conn| {
                conn.execute(
                    "INSERT INTO skill_budget_usage \
                     (run_id, skill_id, tokens, cost_cents, elapsed_ms) \
                     VALUES (?1,?2,?3,?4,?5) \
                     ON CONFLICT(run_id, skill_id) DO UPDATE SET \
                       tokens=tokens+?3, cost_cents=cost_cents+?4, elapsed_ms=elapsed_ms+?5",
                    params![
                        run_id,
                        skill_id,
                        inc.tokens as i64,
                        inc.cost_cents as i64,
                        inc.elapsed_ms as i64,
                    ],
                )
            })
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    fn list_budget_skill_ids(&self) -> Vec<String> {
        self.db
            .with_conn(|conn| -> SqliteResult<Vec<String>> {
                let mut stmt = conn.prepare("SELECT skill_id FROM skill_budgets")?;
                let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
                let mut v = Vec::new();
                for row in rows {
                    v.push(row?);
                }
                Ok(v)
            })
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skill::budget::BudgetVerdict;

    fn tmp_db() -> Arc<DbConnection> {
        let dir = std::env::temp_dir()
            .join(format!("onedesk_budget_{}", uuid::Uuid::new_v4().simple()));
        Arc::new(DbConnection::open(&dir).expect("open test db"))
    }

    #[test]
    fn set_then_get_budget() {
        let db = tmp_db();
        let t = SqliteSkillBudgetTracker::new(db);
        let b = SkillBudget {
            token_limit: Some(1000),
            cost_cents_limit: Some(200),
            time_secs_limit: Some(30),
        };
        t.set_budget("ag_w1", &b).unwrap();
        let got = t.get_budget("ag_w1");
        assert_eq!(got, b);
        
        assert_eq!(t.get_budget("missing"), SkillBudget::default());
    }

    #[test]
    fn usage_accumulates() {
        let db = tmp_db();
        let t = SqliteSkillBudgetTracker::new(db);
        t.record_usage("run1", "ag_w1", &SkillUsage { tokens: 10, cost_cents: 5, elapsed_ms: 1000 }).unwrap();
        t.record_usage("run1", "ag_w1", &SkillUsage { tokens: 20, cost_cents: 7, elapsed_ms: 2000 }).unwrap();
        let u = t.get_usage("run1", "ag_w1");
        assert_eq!(u.tokens, 30);
        assert_eq!(u.cost_cents, 12);
        assert_eq!(u.elapsed_ms, 3000);
        
        assert_eq!(t.get_usage("run2", "ag_w1"), SkillUsage::default());
    }

    #[test]
    fn check_escalates_when_over_token_budget() {
        let db = tmp_db();
        let t = SqliteSkillBudgetTracker::new(db);
        t.set_budget("ag_w1", &SkillBudget { token_limit: Some(10), ..Default::default() }).unwrap();
        t.record_usage("run1", "ag_w1", &SkillUsage { tokens: 5, ..Default::default() }).unwrap();
        assert_eq!(t.check("run1", "ag_w1"), BudgetVerdict::Within);
        t.record_usage("run1", "ag_w1", &SkillUsage { tokens: 10, ..Default::default() }).unwrap();
        assert!(matches!(t.check("run1", "ag_w1"), BudgetVerdict::Exceeded(_)));
    }
}

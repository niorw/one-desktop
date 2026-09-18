




use serde::{Deserialize, Serialize};







#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct SkillBudget {
    pub token_limit: Option<u64>,
    pub cost_cents_limit: Option<u64>,
    pub time_secs_limit: Option<u64>,
}

impl SkillBudget {
    
    pub fn is_unbounded(&self) -> bool {
        self.token_limit.is_none() && self.cost_cents_limit.is_none() && self.time_secs_limit.is_none()
    }
}


#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SkillUsage {
    pub tokens: u64,
    pub cost_cents: u64,
    pub elapsed_ms: u64,
}


#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BudgetVerdict {
    Within,
    Exceeded(String),
}


pub fn skill_id_of(tool_name: &str) -> Option<String> {
    let rest = tool_name.strip_prefix("skill__")?;
    let (id, _) = rest.split_once("__")?;
    if id.is_empty() {
        None
    } else {
        Some(id.to_string())
    }
}


pub struct SkillBudgetGuard;

impl SkillBudgetGuard {
    pub fn evaluate(budget: &SkillBudget, usage: &SkillUsage) -> BudgetVerdict {
        if let Some(lim) = budget.token_limit {
            if usage.tokens > lim {
                return BudgetVerdict::Exceeded(format!("token 预算超限 {} > {}", usage.tokens, lim));
            }
        }
        if let Some(lim) = budget.cost_cents_limit {
            if usage.cost_cents > lim {
                return BudgetVerdict::Exceeded(format!(
                    "成本预算超限 {} > {} 分",
                    usage.cost_cents, lim
                ));
            }
        }
        if let Some(lim) = budget.time_secs_limit {
            let lim_ms = lim.saturating_mul(1000);
            if usage.elapsed_ms > lim_ms {
                return BudgetVerdict::Exceeded(format!(
                    "耗时预算超限 {}ms > {}ms",
                    usage.elapsed_ms, lim_ms
                ));
            }
        }
        BudgetVerdict::Within
    }
}


pub trait SkillBudgetTracker: Send + Sync {
    
    fn get_budget(&self, skill_id: &str) -> SkillBudget;
    
    fn get_usage(&self, run_id: &str, skill_id: &str) -> SkillUsage;
    
    fn set_budget(&self, skill_id: &str, b: &SkillBudget) -> Result<(), String>;
    
    fn record_usage(&self, run_id: &str, skill_id: &str, inc: &SkillUsage) -> Result<(), String>;
    
    fn list_budget_skill_ids(&self) -> Vec<String>;
    
    fn check(&self, run_id: &str, skill_id: &str) -> BudgetVerdict {
        let b = self.get_budget(skill_id);
        let u = self.get_usage(run_id, skill_id);
        SkillBudgetGuard::evaluate(&b, &u)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unbounded_budget_is_within() {
        let b = SkillBudget::default();
        assert!(b.is_unbounded());
        assert_eq!(
            SkillBudgetGuard::evaluate(
                &b,
                &SkillUsage {
                    tokens: 1_000_000,
                    cost_cents: 9_999,
                    elapsed_ms: 9_999_999,
                }
            ),
            BudgetVerdict::Within
        );
    }

    #[test]
    fn token_limit_enforced() {
        let b = SkillBudget {
            token_limit: Some(100),
            ..Default::default()
        };
        assert_eq!(
            SkillBudgetGuard::evaluate(&b, &SkillUsage { tokens: 100, ..Default::default() }),
            BudgetVerdict::Within
        );
        match SkillBudgetGuard::evaluate(&b, &SkillUsage { tokens: 101, ..Default::default() }) {
            BudgetVerdict::Exceeded(r) => assert!(r.contains("token"), "{}", r),
            other => panic!("expected Exceeded, got {:?}", other),
        }
    }

    #[test]
    fn cost_limit_enforced() {
        let b = SkillBudget {
            cost_cents_limit: Some(500),
            ..Default::default()
        };
        match SkillBudgetGuard::evaluate(&b, &SkillUsage { cost_cents: 501, ..Default::default() }) {
            BudgetVerdict::Exceeded(r) => assert!(r.contains("成本"), "{}", r),
            other => panic!("expected Exceeded, got {:?}", other),
        }
    }

    #[test]
    fn time_limit_enforced() {
        let b = SkillBudget {
            time_secs_limit: Some(10),
            ..Default::default()
        };
        assert_eq!(
            SkillBudgetGuard::evaluate(&b, &SkillUsage { elapsed_ms: 10_000, ..Default::default() }),
            BudgetVerdict::Within
        );
        match SkillBudgetGuard::evaluate(&b, &SkillUsage { elapsed_ms: 10_001, ..Default::default() }) {
            BudgetVerdict::Exceeded(r) => assert!(r.contains("耗时"), "{}", r),
            other => panic!("expected Exceeded, got {:?}", other),
        }
    }

    #[test]
    fn skill_id_of_parses() {
        assert_eq!(skill_id_of("skill__ag_w1__do_x"), Some("ag_w1".to_string()));
        assert_eq!(skill_id_of("mcp__srv__tool"), None);
        assert_eq!(skill_id_of("run_shell"), None);
        assert_eq!(skill_id_of("skill__"), None);
        assert_eq!(skill_id_of("skill____x"), None);
    }

    
    struct MockTracker {
        budget: SkillBudget,
        usage: SkillUsage,
    }
    impl SkillBudgetTracker for MockTracker {
        fn get_budget(&self, _: &str) -> SkillBudget {
            self.budget
        }
        fn get_usage(&self, _: &str, _: &str) -> SkillUsage {
            self.usage
        }
        fn set_budget(&self, _: &str, _: &SkillBudget) -> Result<(), String> {
            Ok(())
        }
        fn record_usage(&self, _: &str, _: &str, _: &SkillUsage) -> Result<(), String> {
            Ok(())
        }
        fn list_budget_skill_ids(&self) -> Vec<String> {
            Vec::new()
        }
    }

    #[test]
    fn check_combines_budget_and_usage() {
        let over = MockTracker {
            budget: SkillBudget {
                token_limit: Some(50),
                ..Default::default()
            },
            usage: SkillUsage {
                tokens: 60,
                ..Default::default()
            },
        };
        assert!(matches!(over.check("run1", "ag_w1"), BudgetVerdict::Exceeded(_)));

        let under = MockTracker {
            budget: SkillBudget {
                token_limit: Some(50),
                ..Default::default()
            },
            usage: SkillUsage {
                tokens: 40,
                ..Default::default()
            },
        };
        assert_eq!(under.check("run1", "ag_w1"), BudgetVerdict::Within);
    }
}

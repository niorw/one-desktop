













use std::collections::HashSet;
use std::sync::Arc;

use crate::group::agent_profile::CreateAgentProfilePayload;
use crate::group::agent_repo::AgentProfileRepository;
use crate::storage::connection::DbConnection;
use crate::storage::repository::Repository;


pub struct FunctionalPreset {
    
    pub slug: &'static str,
    
    pub name: &'static str,
    
    pub system_prompt: String,
    
    pub capabilities: &'static [&'static str],
    
    pub tools: &'static [&'static str],
}



fn functional_prompt(name: &str, role: &str, duties: &str) -> String {
    format!(
        "# 身份\n\
         你是群内的一名 AI Agent，担任「{}」。\n\
         \n\
         # 核心职责\n\
         {}\n\
         \n\
         # 协作规则\n\
         {}\n\
         \n\
         # 行为准则\n\
         1. 除非被 @ 或在讨论你的专业领域，否则不抢话。\n\
         2. 不做超出自身职能的决策；需要其它角色配合时明确 @ 对方。\n\
         3. 输出直接、可落地，不空谈；复杂议题先给结论再展开。\n\
         \n\
         # 回复要求\n\
         直接输出专业内容，不要输出思考过程。",
        name, role, duties
    )
}


pub fn functional_presets() -> Vec<FunctionalPreset> {
    vec![
        FunctionalPreset {
            slug: "product-manager",
            name: "产品经理",
            system_prompt: functional_prompt(
                "产品经理",
                "你是群内的产品经理（PM），负责定义产品方向、拆解需求与管理优先级。\n\
                 - 将模糊目标转化为清晰、可衡量的需求与用户故事\n\
                 - 制定功能优先级（按价值 / 成本 / 风险权衡）\n\
                 - 在研发与设计中充当需求澄清的锚点",
                "被 @ 或收到派活时：\n\
                 - 输出结构化需求文档 / 验收标准，而非空泛描述\n\
                 - 主动指出需求中的歧义、缺失与矛盾\n\
                 - 不替架构 / 研发做技术决策，但可提出约束与边界\n\
                 - 作为协调者：收到模糊目标时，先把它拆成带 depends_on 的 SubTask 批次（每条含 id/description/depends_on/capability/reasoning），\n\
                   再调用 assign_tasks 工具提交（群主在任务看板「待审批」列批准后才会执行，勿自行开跑）",
            ),
            capabilities: &["product", "requirements"],
            tools: &[],
        },
        FunctionalPreset {
            slug: "ui-designer",
            name: "UI 设计师",
            system_prompt: functional_prompt(
                "UI 设计师",
                "你是群内的 UI 设计师，负责产品的视觉与交互体验。\n\
                 - 将需求转化为信息架构、交互流程与视觉方案\n\
                 - 保证一致的设计语言（间距 / 层级 / 配色 / 组件）\n\
                 - 输出可落地的设计说明或原型描述",
                "被 @ 或收到派活时：\n\
                 - 给出具体设计方案（含布局 / 层级 / 交互细节），而非「好看就行」\n\
                 - 与产品经理对齐需求，与研发对齐实现可行性\n\
                 - 指出体验风险（复杂操作 / 认知负担）",
            ),
            capabilities: &["design", "ui"],
            tools: &[],
        },
        FunctionalPreset {
            slug: "engineer",
            name: "研发工程师",
            system_prompt: functional_prompt(
                "研发工程师",
                "你是群内的研发工程师，负责把需求与设计方案实现为代码。\n\
                 - 在给定约束下编写正确、可读、可维护的代码\n\
                 - 评估技术可行性，提出实现方案与取舍\n\
                 - 定位并修复缺陷",
                "被 @ 或收到派活时：\n\
                 - 给出可运行的代码或明确的实现步骤\n\
                 - 主动说明技术风险、依赖与预估工时\n\
                 - 不擅自扩大需求范围，遇到歧义先澄清",
            ),
            capabilities: &["codegen", "review"],
            tools: &["fs", "shell"],
        },
        FunctionalPreset {
            slug: "architect",
            name: "系统架构师",
            system_prompt: functional_prompt(
                "系统架构师",
                "你是群内的系统架构师，负责技术选型、系统结构与关键设计决策。\n\
                 - 设计模块边界、接口契约与数据流\n\
                 - 评估方案的可扩展性、可靠性与一致性\n\
                 - 在技术债务与交付速度间权衡",
                "被 @ 或收到派活时：\n\
                 - 输出架构图 / 接口定义 / 技术选型对比，而非代码片段\n\
                 - 明确指出非功能性风险（性能 / 安全 / 并发）\n\
                 - 与研发对齐落地路径，与产品对齐技术约束",
            ),
            capabilities: &["architecture", "design"],
            tools: &[],
        },
        FunctionalPreset {
            slug: "qa",
            name: "测试工程师",
            system_prompt: functional_prompt(
                "测试工程师",
                "你是群内的测试工程师（QA），负责保障交付质量。\n\
                 - 设计测试用例（功能 / 边界 / 异常 / 回归）\n\
                 - 识别质量风险与遗漏场景\n\
                 - 推动缺陷闭环",
                "被 @ 或收到派活时：\n\
                 - 输出可执行的测试清单或缺陷报告\n\
                 - 对每个研发产出做「如何验证」的审视\n\
                 - 不写业务代码，但可给出复现步骤与验收口径",
            ),
            capabilities: &["qa", "review"],
            tools: &["fs"],
        },
        FunctionalPreset {
            slug: "ops",
            name: "运营策划",
            system_prompt: functional_prompt(
                "运营策划",
                "你是群内的运营策划，负责增长、活动与用户运营。\n\
                 - 设计运营节奏、活动机制与转化路径\n\
                 - 将产品能力翻译为可传播的运营动作\n\
                 - 关注拉新 / 留存 / 活跃等核心指标",
                "被 @ 或收到派活时：\n\
                 - 给出可执行的活动方案或运营策略\n\
                 - 与产品对齐功能，与数据分析师对齐效果度量\n\
                 - 提出可量化的目标与复盘口径",
            ),
            capabilities: &["ops", "growth"],
            tools: &[],
        },
        FunctionalPreset {
            slug: "hr",
            name: "HR 顾问",
            system_prompt: functional_prompt(
                "HR 顾问",
                "你是群内的 HR 顾问，负责人事、组织与协作效能。\n\
                 - 角色与职责澄清、分工建议\n\
                 - 招聘画像与面试要点\n\
                 - 团队沟通与冲突的协调视角",
                "被 @ 或收到派活时：\n\
                 - 给出结构化的人力 / 组织建议\n\
                 - 关注人岗匹配与协作摩擦，而非技术细节\n\
                 - 对敏感人事议题保持中立、合规",
            ),
            capabilities: &["hr", "org"],
            tools: &[],
        },
        FunctionalPreset {
            slug: "data-analyst",
            name: "数据分析师",
            system_prompt: functional_prompt(
                "数据分析师",
                "你是群内的数据分析师，负责从数据中提炼结论。\n\
                 - 设计指标口径与取数逻辑\n\
                 - 做描述性与诊断性分析，定位问题根因\n\
                 - 用数据支撑产品 / 运营决策",
                "被 @ 或收到派活时：\n\
                 - 给出分析框架、关键指标与结论，而非堆砌数字\n\
                 - 主动声明数据口径假设与局限性\n\
                 - 与运营 / 产品对齐目标，与研发对齐埋点可行性",
            ),
            capabilities: &["data", "analysis"],
            tools: &["fs"],
        },
    ]
}



pub fn seed_functional_presets(db: &Arc<DbConnection>) -> usize {
    let repo = AgentProfileRepository::new(db.as_ref());
    let existing: HashSet<String> = repo
        .find_all(())
        .map(|v| v.into_iter().map(|a| a.name).collect())
        .unwrap_or_default();

    let mut added = 0;
    for p in functional_presets() {
        if existing.contains(p.name) {
            continue;
        }
        let result = repo.create(CreateAgentProfilePayload {
            name: p.name.into(),
            model: "deepseek-chat".into(),
            system_prompt: p.system_prompt.clone(),
            capabilities: p.capabilities.iter().map(|s| s.to_string()).collect(),
            skills: vec![],
            mcp: vec![],
            tools: p.tools.iter().map(|s| s.to_string()).collect(),
        });
        match result {
            Ok(_) => added += 1,
            Err(e) => tracing::warn!(
                target: "onedesktop.seed",
                functional = p.slug,
                error = %e,
                "failed to seed functional preset"
            ),
        }
    }
    added
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::connection::DbConnection;
    use std::path::PathBuf;

    fn tmp_db() -> DbConnection {
        let dir = PathBuf::from(std::env::temp_dir())
            .join(format!("od_func_test_{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).ok();
        DbConnection::open(&dir).unwrap()
    }

    #[test]
    fn presets_are_unique_and_complete() {
        let all = functional_presets();
        assert_eq!(all.len(), 8, "应有 8 类职能预设");
        let mut names = std::collections::HashSet::new();
        for p in &all {
            assert!(!p.name.is_empty(), "name 不能为空");
            assert!(
                names.insert(p.name),
                "名字必须唯一，重复: {}",
                p.name
            );
            assert!(!p.system_prompt.is_empty(), "system_prompt 不能为空");
            for needle in ["# 身份", "# 核心职责", "# 协作规则", "# 行为准则"] {
                assert!(
                    p.system_prompt.contains(needle),
                    "{} 的 prompt 缺少 {}",
                    p.slug,
                    needle
                );
            }
        }
    }

    #[test]
    fn seed_is_idempotent() {
        let db = Arc::new(tmp_db());
        let first = seed_functional_presets(&db);
        assert_eq!(first, functional_presets().len(), "首次应补齐全部预设");
        let second = seed_functional_presets(&db);
        assert_eq!(second, 0, "再次调用不应重复插入");

        let repo = AgentProfileRepository::new(db.as_ref());
        let all = repo.find_all(()).unwrap();
        assert_eq!(all.len(), functional_presets().len(), "库中应为 8 个预设");
    }

    #[test]
    fn seed_skips_user_custom_same_name() {
        let db = Arc::new(tmp_db());
        let repo = AgentProfileRepository::new(db.as_ref());
        repo.create(CreateAgentProfilePayload {
            name: "产品经理".into(),
            model: "deepseek-chat".into(),
            system_prompt: "用户自定义的人设，不可被模板覆盖。".into(),
            capabilities: vec![],
            skills: vec![],
            mcp: vec![],
            tools: vec![],
        })
        .unwrap();
        let added = seed_functional_presets(&db);
        assert_eq!(added, functional_presets().len() - 1, "同名自定义应被跳过");
        let all = repo.find_all(()).unwrap();
        assert_eq!(all.len(), functional_presets().len());
        let mine = all.iter().find(|a| a.name == "产品经理").unwrap();
        assert_eq!(mine.system_prompt, "用户自定义的人设，不可被模板覆盖。");
    }
}

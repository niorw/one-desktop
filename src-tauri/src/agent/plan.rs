










use crate::llm::client;
use crate::llm::json_repair::repair_json;
use crate::llm::provider::LlmProvider;
use crate::types::{ProposalOption, TodoEntry};






const MULTI_STEP_KEYWORDS: &[&str] = &[
    "方案", "计划", "对比", "比较", "调研", "分析", "报告", "文档",
    "总结", "批量", "清单", "梳理", "归类", "分类", "罗列",
    "汇总", "排版", "设计", "撰写", "编写", "起草", "草拟",
    "部署", "迁移", "重构", "测试", "压测", "评估", "审核",
    "分步", "分阶段", "阶段", "步骤", "流程",
    
    "所有", "全部", "逐个",
];


const MULTI_STEP_CONNECTORS: &[&str] = &[
    "然后", "接着", "随后", "之后", "最后", "并且", "而且", "另外", "此外",
    "分步骤", "逐步",
];





const MAX_SKIP_PLANNING_CHARS: usize = 30;














pub fn should_skip_planning(user_message: &str) -> bool {
    let trimmed = user_message.trim();
    
    if trimmed.is_empty() {
        return true;
    }
    
    if trimmed.contains('\n') || trimmed.contains("```") {
        return false;
    }
    
    if trimmed.chars().count() > MAX_SKIP_PLANNING_CHARS {
        return false;
    }
    
    if MULTI_STEP_KEYWORDS.iter().any(|kw| trimmed.contains(kw)) {
        return false;
    }
    
    if MULTI_STEP_CONNECTORS.iter().any(|c| trimmed.contains(c)) {
        return false;
    }
    
    
    if trimmed.contains("先") && trimmed.contains("再") {
        return false;
    }
    true
}

const PLAN_SYSTEM: &str = r#"你是任务规划器。判断用户请求是否需要多步执行；需要就拆成有序待办清单，并视情况给出一个方案供用户确认。

只输出一个 JSON 对象，格式严格如下（不要任何解释文字、不要 markdown 代码块、不要 ```json 包裹）：
{
  "todos": [
    {"id": "1", "title": "简短动作描述", "active_form": "正在做某事"}
  ],
  "proposal": null
}

规则：
- 闲聊、问候、一句话就能答的简单问题 → todos 填空数组 []，proposal 填 null。不要为简单请求硬凑步骤。
- 需要多步时 todos 给 3~6 项；active_form 是该步骤执行时的进行中短语（如「正在读取配置」）。
- 任务若本质可合并为单一连贯产出（如一次性产出一段/一个文件代码、单次查询、单次生成），即使内部有若干子动作也**不要拆成多条**——合并成 1 条 todo，用整体动作表述。经验线：真正需要 ≥3 步才拆解，≤2 步务必归并为 1 条。例：「用 Java 编写二分查找」是 1 条（「编写二分查找 Java 实现（含测试入口）」），不要拆成「建文件 / 写方法 / 写测试」3 条。
- 只有当任务确实有多条互斥路线、或涉及不可逆/高成本操作（删文件、改线上配置、大额消耗）时，
  才把 proposal 填为：
  {
    "title": "方案标题",
    "summary": "一句话说明要你确认什么",
    "options": [
      {"id": "a", "label": "选项短名", "description": "这个选项做什么", "risk": "low|medium|high", "recommended": true}
    ]
  }
  否则 proposal 一律填 null —— 每次都弹确认会让用户烦躁。options 至少 2 项，recommended 只能有一项。"#;


#[derive(Debug, Default)]
pub struct PlanResult {
    pub todos: Vec<TodoEntry>,
    pub proposal: Option<ProposalDraft>,
}


#[derive(Debug)]
pub struct ProposalDraft {
    pub title: String,
    pub summary: String,
    pub options: Vec<ProposalOption>,
}






pub async fn plan_turn(
    provider: &dyn LlmProvider,
    user_message: &str,
    preamble: &str,
) -> PlanResult {
    let user = format!(
        "用户请求：{}\n\n请把这个请求拆解成有序的待办清单（最多 6 项），并视情况给出一个执行方案供用户确认。\n（参考背景：{}）",
        user_message,
        
        preamble.chars().take(500).collect::<String>(),
    );

    
    let raw = match client::summarize_text(provider, PLAN_SYSTEM, &user, 0.2, 512).await {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(target: "onedesktop.plan", error = %e, "planning LLM failed, skip planning");
            return PlanResult::default();
        }
    };
    parse_plan(&raw)
}

fn parse_plan(raw: &str) -> PlanResult {
    
    
    let v: serde_json::Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => match serde_json::from_str(&repair_json(raw)) {
            Ok(v) => v,
            Err(e) => {
                
                
                tracing::warn!(target: "onedesktop.plan", error = %e, raw = %raw, "plan JSON parse failed, skip planning");
                return PlanResult::default();
            }
        },
    };

    let todos: Vec<TodoEntry> = v
        .get("todos")
        .and_then(|t| t.as_array())
        .map(|arr| {
            arr.iter()
                .enumerate()
                .filter_map(|(i, o)| {
                    let obj = o.as_object()?;
                    let title = obj
                        .get("title")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string();
                    if title.is_empty() {
                        return None;
                    }
                    Some(TodoEntry {
                        id: obj
                            .get("id")
                            .and_then(|x| x.as_str())
                            .unwrap_or(&(i + 1).to_string())
                            .to_string(),
                        title,
                        status: "pending".to_string(),
                        active_form: obj
                            .get("active_form")
                            .and_then(|x| x.as_str())
                            .map(|s| s.to_string()),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let proposal = v
        .get("proposal")
        .and_then(|p| p.as_object())
        .and_then(parse_proposal);

    
    
    if todos.is_empty() {
        return PlanResult::default();
    }
    PlanResult { todos, proposal }
}

fn parse_proposal(p: &serde_json::Map<String, serde_json::Value>) -> Option<ProposalDraft> {
    let title = p
        .get("title")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let summary = p
        .get("summary")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let options: Vec<ProposalOption> = p
        .get("options")
        .and_then(|o| o.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|o| {
                    let obj = o.as_object()?;
                    let label = obj
                        .get("label")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string();
                    if label.is_empty() {
                        return None;
                    }
                    Some(ProposalOption {
                        id: obj
                            .get("id")
                            .and_then(|x| x.as_str())
                            .unwrap_or("opt")
                            .to_string(),
                        label,
                        description: obj
                            .get("description")
                            .and_then(|x| x.as_str())
                            .unwrap_or("")
                            .to_string(),
                        
                        
                        risk: match obj.get("risk").and_then(|x| x.as_str()).unwrap_or("medium") {
                            "low" | "safe" => "low",
                            "high" | "danger" => "high",
                            _ => "medium",
                        }
                        .to_string(),
                        recommended: obj
                            .get("recommended")
                            .and_then(|x| x.as_bool())
                            .unwrap_or(false),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    if options.is_empty() {
        return None;
    }
    Some(ProposalDraft {
        title,
        summary,
        options,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_todos_and_proposal() {
        let raw = r#"{"todos":[{"id":"1","title":"读配置","active_form":"正在读配置"},
            {"id":"2","title":"改端口"}],
            "proposal":{"title":"改法","summary":"选一个","options":[
              {"id":"a","label":"直接改","description":"就地覆盖","risk":"danger","recommended":true},
              {"id":"b","label":"先备份","description":"备份再改","risk":"safe"}]}}"#;
        let r = parse_plan(raw);
        assert_eq!(r.todos.len(), 2);
        assert_eq!(r.todos[0].status, "pending");
        assert_eq!(r.todos[0].active_form.as_deref(), Some("正在读配置"));
        let p = r.proposal.expect("proposal");
        assert_eq!(p.options.len(), 2);
        
        assert_eq!(p.options[0].risk, "high");
        assert_eq!(p.options[1].risk, "low");
        assert!(p.options[0].recommended);
    }

    #[test]
    fn empty_todos_means_no_plan_not_fallback() {
        let r = parse_plan(r#"{"todos":[],"proposal":null}"#);
        assert!(r.todos.is_empty(), "简单请求不该硬凑待办");
        assert!(r.proposal.is_none());
    }

    #[test]
    fn garbage_output_fails_open_to_empty() {
        
        let r = parse_plan("```json\n我觉得应该先看看情况\n");
        assert!(r.todos.is_empty());
        assert!(r.proposal.is_none());
    }

    
    
    #[test]
    fn skip_planning_for_obvious_single_step() {
        assert!(should_skip_planning("查明天北京天气"));
        assert!(should_skip_planning("你好"));
        assert!(should_skip_planning("查天气"));
        assert!(should_skip_planning(""));
        assert!(should_skip_planning("   "));
        assert!(should_skip_planning("帮我看一下上海现在的温度"));
        assert!(should_skip_planning("查一下北京和上海天气")); 
    }

    
    #[test]
    fn keep_planning_when_multi_step_signal_present() {
        
        assert!(!should_skip_planning("写一份关于气候变化的报告"));
        assert!(!should_skip_planning("分析这周的天气趋势"));
        assert!(!should_skip_planning("列出这周要做的所有任务"));
        assert!(!should_skip_planning("对比北京和上海的天气"));
        assert!(!should_skip_planning("分步骤说明"));
        
        assert!(!should_skip_planning("查天气，然后规划明天的行程"));
        assert!(!should_skip_planning("先查上海再查北京"));
    }

    
    #[test]
    fn keep_planning_for_long_or_multiline() {
        let long = "请帮我整理一份从北京到上海的完整行程规划，包含交通、住宿、餐饮、景点等所有细节";
        assert!(!should_skip_planning(long));
        assert!(!should_skip_planning("第一行\n第二行"));
        assert!(!should_skip_planning("```\ncode\n```"));
        assert!(!should_skip_planning("```python\nprint('hi')\n```"));
    }

    #[test]
    fn proposal_without_options_is_dropped() {
        let r = parse_plan(
            r#"{"todos":[{"id":"1","title":"干活"}],"proposal":{"title":"t","summary":"s","options":[]}}"#,
        );
        assert_eq!(r.todos.len(), 1);
        assert!(r.proposal.is_none(), "无选项的方案弹出来没法选");
    }
}

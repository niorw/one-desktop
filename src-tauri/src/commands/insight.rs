



use crate::agent::insight::{GroupInsight, InsightQueries, RunRecord, RunWithSteps, SeatInsight, StepRecord};
use crate::commands::group::GroupState;
use crate::commands::redact::redact_owned;
use tauri::{AppHandle, Manager, Runtime};


#[tauri::command]
pub async fn insight_group_runs<R: Runtime>(
    app: AppHandle<R>,
    group_id: String,
) -> Result<GroupInsight, String> {
    let gdb = app.state::<GroupState>();
    let q = InsightQueries::new(gdb.db.as_ref());
    let summary = q.group_summary(&group_id).map_err(|e| e.to_string())?;
    let runs = q.group_runs(&group_id).map_err(|e| e.to_string())?;
    Ok(GroupInsight { summary, runs })
}


#[tauri::command]
pub async fn insight_seat_runs<R: Runtime>(
    app: AppHandle<R>,
    seat_id: String,
    limit: Option<i64>,
) -> Result<SeatInsight, String> {
    let gdb = app.state::<GroupState>();
    let q = InsightQueries::new(gdb.db.as_ref());
    let summary = q.seat_summary(&seat_id).map_err(|e| e.to_string())?;
    let recent_runs = q
        .seat_runs(&seat_id, limit.unwrap_or(20))
        .map_err(|e| e.to_string())?;
    Ok(SeatInsight { summary, recent_runs })
}





#[tauri::command]
pub async fn export_run_replay<R: Runtime>(
    app: AppHandle<R>,
    group_id: String,
) -> Result<String, String> {
    let gdb = app.state::<GroupState>();
    let q = InsightQueries::new(gdb.db.as_ref());
    let summary = q.group_summary(&group_id).map_err(|e| e.to_string())?;
    let runs = q.group_runs(&group_id).map_err(|e| e.to_string())?;
    if runs.is_empty() {
        return Err("该群还没有运行记录，无可导出的回放".to_string());
    }
    let payload = GroupInsight { summary, runs };
    
    
    let html = render_replay_html(&redact_group_insight(&payload));
    let dir = crate::paths::data_dir().join("exports");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建导出目录失败: {}", e))?;
    let ts = chrono::Utc::now().format("%Y%m%d-%H%M%S");
    let path = dir.join(format!("run-replay-{}-{}.html", group_id, ts));
    std::fs::write(&path, html).map_err(|e| format!("写回放文件失败: {}", e))?;
    Ok(path.to_string_lossy().to_string())
}




fn redact_group_insight(insight: &GroupInsight) -> GroupInsight {
    GroupInsight {
        summary: insight.summary.clone(),
        runs: insight
            .runs
            .iter()
            .map(|rws| RunWithSteps {
                run: {
                    let r = &rws.run;
                    RunRecord {
                        id: r.id.clone(),
                        session_id: r.session_id.clone(),
                        group_id: r.group_id.clone(),
                        seat_id: r.seat_id.as_deref().map(redact_owned),
                        kind: r.kind.clone(),
                        started_at: r.started_at,
                        ended_at: r.ended_at,
                        status: r.status.clone(),
                        model: r.model.as_deref().map(redact_owned),
                        prompt_tokens: r.prompt_tokens,
                        output_tokens: r.output_tokens,
                        iterations: r.iterations,
                    }
                },
                steps: rws
                    .steps
                    .iter()
                    .map(|s| StepRecord {
                        seq: s.seq,
                        kind: s.kind.clone(),
                        name: s.name.as_deref().map(redact_owned),
                        origin: s.origin.as_deref().map(redact_owned),
                        outcome: s.outcome.clone(),
                        duration_ms: s.duration_ms,
                        started_at: s.started_at,
                        args_digest: s.args_digest.as_deref().map(redact_owned),
                    })
                    .collect(),
            })
            .collect(),
    }
}


fn render_replay_html(insight: &GroupInsight) -> String {
    let data = serde_json::to_string(insight).unwrap_or_else(|_| "{}".to_string());
    let run_count = insight.summary.run_count;
    let cost = insight.summary.est_cost_yuan;
    let tokens = insight.summary.prompt_tokens + insight.summary.output_tokens;
    format!(
        r#"<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OneDesktop 运行回放</title>
<style>
  :root {{ color-scheme: light dark; }}
  body {{ font: 14px/1.6 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; max-width: 860px; margin: 0 auto; padding: 24px 16px 64px; }}
  h1 {{ font-size: 20px; margin: 0 0 4px; }}
  .meta {{ color: #888; font-size: 13px; margin-bottom: 20px; }}
  .summary {{ display: flex; gap: 24px; flex-wrap: wrap; padding: 12px 16px; border: 1px solid #ddd; border-radius: 8px; margin-bottom: 20px; }}
  .summary b {{ display: block; font-size: 18px; }}
  .summary span {{ color: #888; font-size: 12px; }}
  .run {{ border: 1px solid #ddd; border-radius: 8px; margin-bottom: 12px; overflow: hidden; }}
  .run-head {{ display: flex; align-items: center; gap: 12px; padding: 10px 14px; background: rgba(0,0,0,0.03); font-weight: 600; }}
  .run-kind {{ font-size: 11px; padding: 2px 8px; border-radius: 10px; background: #eef; }}
  .run-status {{ margin-left: auto; font-size: 12px; font-weight: 400; }}
  .run-status.ok {{ color: #1a7f37; }}
  .run-status.failed {{ color: #d1242f; }}
  .run-status.running {{ color: #0969da; }}
  .steps {{ padding: 6px 14px 10px; }}
  .step {{ display: flex; align-items: center; gap: 10px; padding: 4px 0; font-size: 13px; }}
  .step-kind {{ width: 34px; font-size: 11px; color: #888; }}
  .step-name {{ font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }}
  .step-outcome {{ margin-left: auto; }}
  .step-outcome.ok {{ color: #1a7f37; }}
  .step-outcome.failed {{ color: #d1242f; }}
  .step-args {{ display: block; margin: 2px 0 4px 44px; padding: 4px 8px; background: rgba(0,0,0,0.04); border-radius: 4px; font-family: ui-monospace, monospace; font-size: 11px; color: #666; word-break: break-all; }}
  .none {{ color: #999; padding: 8px 14px; }}
  @media (prefers-color-scheme: dark) {{
    body {{ background: #161618; color: #e6e6e9; }}
    .summary, .run {{ border-color: #3a3a3c; }}
    .run-head {{ background: rgba(255,255,255,0.04); }}
    .step-args {{ background: rgba(255,255,255,0.06); color: #aaa; }}
    .run-kind {{ background: #1c1c7c; }}
    .meta {{ color: #999; }}
  }}
</style>
</head>
<body>
<h1>OneDesktop 运行回放</h1>
<div class="meta">共 {run_count} 次运行 · 约 {tokens} token · 约 ¥{cost:.3} · 导出于 <span id="ts"></span></div>
<div class="summary">
  <div><b>{run_count}</b><span>运行次数</span></div>
  <div><b>{tokens}</b><span>总 token</span></div>
  <div><b>¥{cost:.3}</b><span>预估成本</span></div>
</div>
<div id="list"></div>
<script>
document.getElementById("ts").textContent = new Date().toLocaleString();
const D = {data};
const S = {{ ok: "✓", failed: "✗", unavailable: "!" }};
const K = {{ llm: "LLM", tool: "工具", approval: "审批" }};
const list = document.getElementById("list");
for (const item of D.runs) {{
  const r = item.run;
  const dur = r.ended_at != null ? (r.ended_at - r.started_at) + "ms" : "…";
  const div = document.createElement("div");
  div.className = "run";
  const head = document.createElement("div");
  head.className = "run-head";
  head.innerHTML = `<span class="run-kind">${{r.kind}}</span><span>${{r.seat_id || "—"}}</span><span style="color:#999;font-weight:400">${{r.model || ""}}</span><span class="run-status ${{r.status}}">${{r.status}} · ${{dur}} · ${{r.prompt_tokens}}/${{r.output_tokens}} tok</span>`;
  div.appendChild(head);
  const steps = document.createElement("div");
  steps.className = "steps";
  if (item.steps.length === 0) {{
    steps.innerHTML = '<div class="none">（无步骤明细）</div>';
  }} else {{
    for (const s of item.steps) {{
      const row = document.createElement("div");
      row.className = "step";
      row.innerHTML = `<span class="step-kind">${{K[s.kind] || s.kind}}</span><span class="step-name">${{s.name || "—"}}</span><span style="color:#999;font-size:11px">${{s.origin || ""}}</span><span class="step-outcome ${{s.outcome}}">${{S[s.outcome] || "?"}}</span>`;
      steps.appendChild(row);
      if (s.args_digest) {{
        const args = document.createElement("code");
        args.className = "step-args";
        args.textContent = s.args_digest;
        steps.appendChild(args);
      }}
    }}
  }}
  div.appendChild(steps);
  list.appendChild(div);
}}
</script>
</body>
</html>"#
    )
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::insight::{GroupRunSummary, RunRecord, StepRecord};

    fn sample_insight() -> GroupInsight {
        GroupInsight {
            summary: GroupRunSummary {
                run_count: 1,
                prompt_tokens: 100,
                output_tokens: 50,
                total_duration_ms: 1000,
                est_cost_yuan: 0.0,
            },
            runs: vec![RunWithSteps {
                run: RunRecord {
                    id: "run-1".into(),
                    session_id: "rt:g:w".into(),
                    group_id: Some("g".into()),
                    seat_id: Some("w".into()),
                    kind: "worker".into(),
                    started_at: 0,
                    ended_at: Some(1000),
                    status: "ok".into(),
                    model: Some("deepseek-chat".into()),
                    prompt_tokens: 100,
                    output_tokens: 50,
                    iterations: 1,
                },
                steps: vec![StepRecord {
                    seq: 1,
                    kind: "tool".into(),
                    name: Some("read_file".into()),
                    origin: Some("worker".into()),
                    outcome: "ok".into(),
                    duration_ms: Some(500),
                    started_at: 0,
                    args_digest: Some("path=~/.one-desktop/memory/USER.md 内容含 <user_profile>用户喜欢简洁</user_profile>".into()),
                }],
            }],
        }
    }

    #[test]
    fn replay_export_redacts_sensitive_args() {
        let insight = sample_insight();
        let redacted = redact_group_insight(&insight);
        let json = serde_json::to_string(&redacted).unwrap();
        
        assert!(!json.contains("用户喜欢简洁"));
        assert!(!json.contains("<user_profile>"));
        assert!(json.contains("〔已脱敏 · 个人记忆内容〕"));
        
        assert!(json.contains("read_file"));
        assert!(json.contains("deepseek-chat"));
        assert!(json.contains("run-1"));
    }

    #[test]
    fn replay_export_plain_text_untouched() {
        let mut insight = sample_insight();
        
        insight.runs[0].steps[0].args_digest = Some("path=src/main.rs".into());
        let redacted = redact_group_insight(&insight);
        assert_eq!(redacted.runs[0].steps[0].args_digest.as_deref(), Some("path=src/main.rs"));
        assert!(!serde_json::to_string(&redacted).unwrap().contains("已脱敏"));
    }

    #[test]
    fn replay_export_redacts_seat_and_model_too() {
        let mut insight = sample_insight();
        insight.runs[0].run.seat_id = Some("<user_profile>画像席位</user_profile>".into());
        let redacted = redact_group_insight(&insight);
        let json = serde_json::to_string(&redacted).unwrap();
        assert!(!json.contains("画像席位"));
        assert!(json.contains("〔已脱敏 · 个人记忆内容〕"));
    }
}

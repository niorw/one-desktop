// Injectable Tauri backend mock for headless UI E2E.
//
// The real OneDesktop backend lives in Rust (Tauri). When running the frontend
// in a plain browser (vite dev / Playwright) there is no Tauri runtime, so every
// `invoke(...)` would throw. This mock installs `window.__TAURI_INTERNALS__` with
// an in-memory backend that mirrors the commands the UI touches, plus a tiny event
// bus so flows that depend on backend-pushed events (batch_completed,
// roundtable-summary) still work end-to-end through the REAL React components.
//
// It is intentionally self-contained (no imports) so it can be serialised by
// Playwright's `addInitScript`.

export function installTauriMock() {
  const now = Date.now();
  const uid = () =>
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : "id-" + Math.random().toString(36).slice(2);

  // ── in-memory DB ──────────────────────────────────────────────
  const presets = [
    { id: "p_researcher", name: "Researcher", model: "deepseek-chat", system_prompt: "研究型 agent", capabilities: ["search", "summarize"], skills: [], mcp: [], tools: [], created_at: now },
    { id: "p_writer", name: "Writer", model: "deepseek-chat", system_prompt: "写作型 agent", capabilities: ["write"], skills: [], mcp: [], tools: [], created_at: now },
    { id: "p_coder", name: "Coder", model: "deepseek-chat", system_prompt: "编码型 agent", capabilities: ["code"], skills: [], mcp: [], tools: [], created_at: now },
  ];

  // F12 拓扑策略快照（group_topology_get/set 的内存态）
  const topologySnapshots: Record<string, any> = {};

  // F7 共享黑板（group_blackboard_get/set 的内存态，命名空间按 group_id）
  const blackboardSnapshots: Record<string, Record<string, { value: string; version: number }>> = {};

  const groups: any[] = [
    {
      id: "g_demo",
      name: "竞品分析群",
      goal: "对三款竞品做功能与定价对比",
      owner_agent_ref: "p_researcher",
      status: "Active",
      // 224c401：群性质（Dev/Research/Chat）。前端 GroupsPage 徽章渲染
      // activeGroup.kind.toLowerCase()，缺了会整树崩溃白屏。
      kind: "Chat",
      seat_config: {},
      created_at: now,
    },
  ];

  const workers: Record<string, any[]> = {
    g_demo: [
      { id: "w1", group_id: "g_demo", agent_ref: "p_writer", seat_type: "Static", status: "Idle", max_concurrency: 1, capabilities: ["write"], current_task_id: null, last_heartbeat: Math.floor(now / 1000) },
      { id: "w2", group_id: "g_demo", agent_ref: "p_coder", seat_type: "Static", status: "Busy", max_concurrency: 1, capabilities: ["code"], current_task_id: null, last_heartbeat: Math.floor(now / 1000) },
    ],
  };

  // 相对"现在"生成 ISO 时间（local 时区 round-trip 安全：toISOString 保留瞬时，
  // 日历 ymd() 在 local 解析回同一天）。dayOffset 负数=过去，正数=未来。
  const isoAt = (dayOffset: number, hour: number, min: number) => {
    const d = new Date(now + dayOffset * 86400000);
    d.setHours(hour, min, 0, 0);
    return d.toISOString();
  };

  // ── 看板测试数据 ──
  // 覆盖全部 5 个状态；含 batch 分组、worker 归属、依赖链（t_seo_2 等 t_seo_1）、
  // 产出物（outputs 角标）、retry_count（失败重试角标）、以及一条 InProgress 但
  // last_heartbeat 过期（卡死角标）。personal 群给"个人任务"过滤器喂数据。
  const tasks: Record<string, any[]> = {
    g_demo: [
      { id: "t_seo_1", group_id: "g_demo", batch_id: "bat_seo", worker_id: "w1", assigned_worker: "w1", description: "抓取竞品官网定价页与功能清单", depends_on: [], input_refs: [], output_spec: null, status: "Pending", retry_count: 0, outputs: [], reasoning: null, capability: null, last_heartbeat: null },
      { id: "t_seo_2", group_id: "g_demo", batch_id: "bat_seo", worker_id: "w2", assigned_worker: "w2", description: "解析定价模型并生成对比表", depends_on: ["t_seo_1"], input_refs: [], output_spec: null, status: "InProgress", retry_count: 0, outputs: [], reasoning: null, capability: "code", last_heartbeat: Math.floor(now / 1000) },
      { id: "t_seo_3", group_id: "g_demo", batch_id: "bat_seo", worker_id: "w1", assigned_worker: "w1", description: "输出竞品功能矩阵 v1（Markdown）", depends_on: [], input_refs: ["t_seo_1"], output_spec: "matrix.md", status: "Completed", retry_count: 0, outputs: ["matrix.md"], reasoning: null, capability: null, last_heartbeat: Math.floor(now / 1000) },
      { id: "t_api_1", group_id: "g_demo", batch_id: null, worker_id: "w2", assigned_worker: "w2", description: "调用第三方 API 拉取用户评论数据", depends_on: [], input_refs: [], output_spec: null, status: "Failed", retry_count: 2, outputs: [], reasoning: null, capability: null, last_heartbeat: Math.floor(now / 1000) },
      { id: "t_old_1", group_id: "g_demo", batch_id: null, worker_id: null, assigned_worker: null, description: "旧版周报模板（已废弃，待清理）", depends_on: [], input_refs: [], output_spec: null, status: "Cancelled", retry_count: 0, outputs: [], reasoning: null, capability: null, last_heartbeat: null },
      { id: "t_draft_1", group_id: "g_demo", batch_id: null, worker_id: "w1", assigned_worker: "w1", description: "撰写竞品分析终稿", depends_on: [], input_refs: ["t_seo_3"], output_spec: null, status: "InProgress", retry_count: 0, outputs: [], reasoning: null, capability: "write", last_heartbeat: Math.floor(now / 1000) - 300 },
    ],
    personal: [
      { id: "t_me_1", group_id: "personal", batch_id: null, worker_id: null, assigned_worker: null, description: "整理本周团队会议纪要", depends_on: [], input_refs: [], output_spec: null, status: "Pending", retry_count: 0, outputs: [], reasoning: null, capability: null, last_heartbeat: null },
      { id: "t_me_2", group_id: "personal", batch_id: null, worker_id: null, assigned_worker: null, description: "起草下季度 OKR", depends_on: [], input_refs: [], output_spec: null, status: "InProgress", retry_count: 0, outputs: [], reasoning: null, capability: null, last_heartbeat: Math.floor(now / 1000) },
      { id: "t_me_3", group_id: "personal", batch_id: null, worker_id: null, assigned_worker: null, description: "回复客户跟进邮件", depends_on: [], input_refs: [], output_spec: null, status: "Completed", retry_count: 0, outputs: ["reply.md"], reasoning: null, capability: null, last_heartbeat: Math.floor(now / 1000) },
    ],
  };

  // ── 日历定时任务测试数据 ──
  // next_run_at 围绕"现在"分布，覆盖 5 种状态与各 schedule 类型，让月历有状态点、
  // 今日单元格有 4 个任务（验证 +N 溢出），选中当日面板有条目。
  const scheduledTasks: any[] = [
    { id: "st_daily", title: "每日竞品价格快照", description: "抓取并归档当日竞品定价", type_: "agent", schedule: { cron: "0 9 * * *", once: null, interval: null }, source: "user", status: "active", action_type: "prompt", action_payload: "抓取竞品价格", created_at: new Date(now - 86400000).toISOString(), updated_at: new Date(now - 3600000).toISOString(), last_run_at: isoAt(-1, 9, 0), next_run_at: isoAt(0, 9, 0), run_count: 12 },
    { id: "st_today_a", title: "整理当日舆情摘要", description: "聚合当日舆情要点", type_: "agent", schedule: { cron: "0 11 * * *", once: null, interval: null }, source: "user", status: "active", action_type: "prompt", action_payload: "舆情摘要", created_at: new Date(now - 86400000).toISOString(), updated_at: new Date(now - 3600000).toISOString(), last_run_at: isoAt(-1, 11, 0), next_run_at: isoAt(0, 11, 0), run_count: 9 },
    { id: "st_today_b", title: "待办的临时备份", description: "临时数据备份（已暂停）", type_: "agent", schedule: { cron: null, once: null, interval: "PT2H" }, source: "user", status: "paused", action_type: "prompt", action_payload: "备份", created_at: new Date(now - 86400000).toISOString(), updated_at: new Date(now - 3600000).toISOString(), last_run_at: isoAt(-1, 13, 0), next_run_at: isoAt(0, 15, 0), run_count: 4 },
    { id: "st_fail", title: "失败重试的舆情抓取", description: "抓取舆情，失败待重试", type_: "agent", schedule: { cron: null, once: null, interval: "PT6H" }, source: "user", status: "failed", action_type: "prompt", action_payload: "舆情抓取", created_at: new Date(now - 86400000).toISOString(), updated_at: new Date(now - 3600000).toISOString(), last_run_at: isoAt(0, 4, 0), next_run_at: isoAt(0, 22, 0), run_count: 5 },
    { id: "st_weekly", title: "周报自动生成", description: "汇总本周群协作产出", type_: "agent", schedule: { cron: "0 18 * * 5", once: null, interval: null }, source: "user", status: "active", action_type: "prompt", action_payload: "生成周报", created_at: new Date(now - 7 * 86400000).toISOString(), updated_at: new Date(now - 86400000).toISOString(), last_run_at: isoAt(-4, 18, 0), next_run_at: isoAt(2, 18, 0), run_count: 8 },
    { id: "st_monthly", title: "月度成本汇总", description: "统计 Agent 调用成本", type_: "agent", schedule: { cron: null, once: null, interval: "P1M" }, source: "system", status: "paused", action_type: "prompt", action_payload: "成本汇总", created_at: new Date(now - 30 * 86400000).toISOString(), updated_at: new Date(now - 86400000).toISOString(), last_run_at: isoAt(-20, 10, 0), next_run_at: isoAt(5, 10, 0), run_count: 3 },
    { id: "st_once", title: "一次性数据归档", description: "归档上月运行日志", type_: "agent", schedule: { cron: null, once: isoAt(-1, 2, 0), interval: null }, source: "user", status: "completed", action_type: "prompt", action_payload: "归档日志", created_at: new Date(now - 2 * 86400000).toISOString(), updated_at: new Date(now - 86400000).toISOString(), last_run_at: isoAt(-1, 2, 0), next_run_at: isoAt(-1, 2, 0), run_count: 1 },
    { id: "st_expired", title: "过期未执行的巡检", description: "每周日巡检，已过期", type_: "agent", schedule: { cron: "0 3 * * 0", once: null, interval: null }, source: "system", status: "expired", action_type: "prompt", action_payload: "巡检", created_at: new Date(now - 14 * 86400000).toISOString(), updated_at: new Date(now - 8 * 86400000).toISOString(), last_run_at: isoAt(-8, 3, 0), next_run_at: isoAt(-3, 3, 0), run_count: 6 },
  ];
  // 长任务恢复面板默认样例（引用已存在的 scheduled task id 与一条 chat 会话，
  // 方便对照）。用例可用 window.__mockLongTaskInterruptions 覆写为任意场景
  // （含空数组以测试空态）。
  (window as any).__mockLongTaskInterruptions = [
    { run_id: "run_st_daily_3", session_id: "sess_st_daily", session_title: "每日竞品价格快照", job_id: "st_daily", kind: "scheduled", status: "interrupted", attempt_no: 2, iteration: 3, tokens_used: 9200, model: "deepseek-v4-flash", started_at: now - 3600000 },
    { run_id: "run_chat_1", session_id: "sess_chat_1", session_title: "帮我整理本周会议纪要", job_id: null, kind: "chat", status: "paused", attempt_no: 1, iteration: 5, tokens_used: 4100, model: "deepseek-v4-flash", started_at: now - 7200000 },
  ];

  // Worker 协作指标（mock 下缺省空列表，供 group_list_worker_metrics 返回）
  const metrics: Record<string, any[]> = {};
  const messages: Record<string, any[]> = {
    g_demo: [
      { seq: 1, group_id: "g_demo", author: "p_researcher", author_kind: "owner", content: "我们先梳理竞品清单。", mentions: [], created_at: now - 60000 },
      { seq: 2, group_id: "g_demo", author: "w1", author_kind: "worker", content: "已收集 A 产品的公开功能列表。", mentions: [], created_at: now - 40000 },
      { seq: 3, group_id: "g_demo", author: "w2", author_kind: "worker", content: "B 产品的定价模型偏向订阅制。", mentions: [], created_at: now - 20000 },
    ],
  };
  const summaries: Record<string, any[]> = {
    g_demo: [
      { id: 1, group_id: "g_demo", content: "竞品 A 功能最全，B 定价更灵活，C 适合中小团队。", source_seq_start: 1, source_seq_end: 3, message_count: 3, created_at: now - 10000 },
    ],
  };
  // 产出物预览（docs/design/deliverable-preview-arch.md，P0）：播种带 media 的产出物，
  // 供 ArtifactPreview 容器与各类渲染器在 E2E 下验证（图片 + CSV 文件 + 正文 markdown）。
  const deliverables: Record<string, any[]> = {
    g_demo: [
      {
        id: "d_seed_1",
        kind: "reply",
        title: "研究员回复",
        author: "w1",
        worker_id: "w1",
        created_at: now - 30000,
        preview: "# 竞品分析初稿\nA 功能最全，B 定价灵活。",
        content: "# 竞品分析初稿\n\n## A 产品\n- 功能最全\n- 适合企业\n\n## B 产品\n- 定价灵活\n- 订阅制",
        ref_seq: 2,
        ref_id: null,
        meta: "",
        media: [
          { type: "image", path: "/Users/test/one-desktop/workspaces/demo/report.png", name: "report.png", size: 12345, mime: "image/png" },
          { type: "file", path: "/Users/test/one-desktop/workspaces/demo/report.csv", name: "report.csv", size: 678, mime: "text/csv" },
        ],
        // P1 溯源：reply 关联其圆桌会话 session（与 worker_session_id 一致）。
        trace_ref: { source: "roundtable", key: "rt:g_demo:w1" },
      },
      {
        id: "d_seed_2",
        kind: "task_output",
        title: "每日竞品价格快照",
        author: "w2",
        worker_id: "w2",
        created_at: now - 40000,
        preview: "| 产品 | 价格 |\n|---|---|\n| A | ¥199/月 |",
        content:
          "## 价格快照\n\n| 产品 | 价格 |\n|---|---|\n| A | ¥199/月 |\n| B | ¥99/月 |\n| C | ¥49/月 |",
        ref_seq: null,
        ref_id: null,
        meta: "",
        media: [],
        // P1 溯源：task_output 关联其 worker run session（与 scheduler 派活 session 一致）。
        trace_ref: { source: "run", key: "g_demo:w2" },
      },
    ],
  };

  const sessions: any[] = [];
  let msgSeq = 100;

  // ── 侧栏过滤验收钩子：仅当测试显式置位 window.__SEED_GROUP_SESSION__ 时，
  // 才在初始化阶段预置一条普通会话 + 一条群会话（mode="group"）。群会话应被
  // Sidebar 的 WorkspaceTree 过滤、只出现在 GroupList。标志经 addInitScript 埋入，
  // 不影响其它用例，且 reload 后仍生效（addInitScript 每次导航都执行）。──
  if ((window as any).__SEED_GROUP_SESSION__) {
    sessions.push({
      id: "seed-normal-1",
      title: "需求梳理任务",
      model: "deepseek-chat",
      preamble: "",
      workspace_id: null,
      created_at: String(now),
      mode: null,
      group_id: null,
    });
    sessions.push({
      id: "seed-group-1",
      title: "竞品分析群会话",
      model: "deepseek-chat",
      preamble: "",
      workspace_id: null,
      created_at: String(now),
      mode: "group",
      group_id: "g_demo",
    });
  }

  // ── 项目 / 灵感（SQLite 化后走命令层，mock 用内存数组镜像）──
  const mockWorkspaces: any[] = [
    { id: "default", name: "任务", icon: null, created_at: now, updated_at: now, session_count: 0 },
  ];
  let mockWebToolsEnabled = false;
  let mockWebSearchProvider = "tavily";
  let mockTavilyKey = "";
  let mockBraveKey = "";
  // 灵感种子：保证首屏时间轴有卡片（对齐旧 localStorage 演示数据）
  const mockInspirations: any[] = [
    {
      id: "insp-seed-2",
      workspace_id: null,
      content: "把「深度思考」的中间态做成可折叠时间轴 #产品",
      tags: ["产品"],
      created_at: now - 3600_000,
    },
    {
      id: "insp-seed-1",
      workspace_id: null,
      content: "灵感是随手记，不是待办：只记录，不催办 #原则",
      tags: ["原则"],
      created_at: now - 7200_000,
    },
  ];

  // ── §9 验收回归：消息存储（镜像真实 DB 的 messages 表落库形状）──
  // send_message 的事件流「事件 + 落库」双写；get_messages 返回该会话已落库消息，
  // 供「切会话再切回」验收断言时间轴一致性（镜像 message_repo::create 的语义：
  // 工具行=assistant+tool_name / 结果=tool+call_id / 思考不单独落库，挂 answer.reasoning_content）。
  const messageStore: Record<string, any[]> = {};

  // ── send_message 运行态跟踪：支持 cancel_agent 中断 mock 事件流 ──
  // 按 session_id 记录当前运行是否被取消及其未发射的 timer id；cancel_agent 调用时
  // 标记取消并清理剩余定时器，使「压缩上下文中」等长延迟场景可被 E2E 中断验证。
  const activeRuns: Record<string, { cancelled: boolean; timers: number[] }> = {};

  // ── callback registry + event bus (mirror Tauri's runtime) ────
  // @tauri-apps/api/event.js routes listen() through transformCallback(handler)
  // (which returns an integer id) and then invoke('plugin:event|listen', {event, handler: id}).
  // We store the real handler by id and fire it via emit() with the same envelope
  // shape Tauri sends: { event, payload, id }.
  const callbackRegistry = new Map<number, { cb: (a: any) => void; once: boolean }>();
  let callbackSeq = 0;

  const eventListeners: Record<string, Array<{ id: number; ev: string; handlerId: number }>> = {};
  let eventSeq = 0;

  const emit = (event: string, payload: any) => {
    const envelope = { event, payload, id: 0 };
    (eventListeners[event] || []).forEach((l) => {
      const entry = callbackRegistry.get(l.handlerId);
      if (entry) entry.cb(envelope);
    });
  };

  // ── invoke ────────────────────────────────────────────────────
  const invoke = async (cmd: string, args: any = {}): Promise<any> => {
    switch (cmd) {
      case "ping":
        return "pong";

      // sessions / chat
      case "list_sessions":
        return sessions;
      case "create_session": {
        const s = { id: uid(), title: args.title ?? "Session", model: args.model ?? "deepseek-chat", preamble: args.preamble ?? "", workspace_id: args.workspaceId ?? null, created_at: now };
        sessions.push(s);
        // e2e 调试：create_session 调用计数（排查双调）
        if (typeof console !== "undefined") console.log(`[mock] create_session #${sessions.length} id=${s.id.slice(0, 8)}`);
        return s;
      }
      case "get_session":
        return sessions.find((s) => s.id === args.sessionId) ?? null;
      case "delete_session":
        return undefined;
      case "get_messages":
        return messageStore[args.sessionId as string] ?? [];
      case "send_message": {
        // ── §9 验收回归事件流 ──
        // mock 后端没有真 LLM：按 content 关键词分发预置事件流，用 setTimeout 序列
        // 回放，驱动真实 React 组件（useAgent → ProcessPanel）。每个事件「发射 +
        // 落库」双写（镜像真实 DB 落库形状），供切会话回放验收。
        // 注意：useAgent 的 Done handler 优先读取 streamingBuf（由 Token 累积），
        // streamingBuf 为空时回退到 event.data.final_response；mock 里两者都传
        // 可保证回答气泡稳定产出。
        const sid = args.sessionId as string;
        const content = typeof args.content === "string" ? args.content : "";
        const store = (messageStore[sid] = messageStore[sid] ?? []);
        const pushMsg = (m: any) =>
          store.push({ id: uid(), seq: ++msgSeq, token_usage: 0, reasoning_content: "", ...m });

        // 用户消息落库（真实后端在同一处写 user 消息）。
        pushMsg({ role: "user", content });

        const isBlank = content.includes("[blank]");
        activeRuns[sid] = { cancelled: false, timers: [] };
        const run = activeRuns[sid];
        const fire = (events: Array<{ delay: number; ev: any; msg?: any }>) => {
          events.forEach(({ delay, ev, msg }) => {
            const t = window.setTimeout(() => {
              if (run.cancelled) return;
              emit("agent-event", ev);
              if (msg) pushMsg(msg);
            }, delay);
            run.timers.push(t);
          });
        };

        // ── [tools3]：同一回合连调 3 次 run_command（G1 call_id 配对验收）──
        // 工具之间夹两段观察（Token 累积 → 下一个 ToolCall flush 成 narration），
        // 供 §9-4 回放断言「观察进过程流」。
        if (content.includes("[tools3]")) {
          const steps = ["one", "two", "three"].map((out, i) => {
            const cid = `run-${i + 1}`;
            return [
              { delay: 40 + i * 200, ev: { type: "ToolCall", data: { session_id: sid, tool_name: "run_command", tool_args: JSON.stringify({ cmd: `echo ${out}` }), call_id: cid } }, msg: { role: "assistant", tool_name: "run_command", tool_args: JSON.stringify({ cmd: `echo ${out}` }), call_id: cid, content: "" } },
              { delay: 100 + i * 200, ev: { type: "ToolResult", data: { session_id: sid, tool_name: "run_command", result: `输出：${out}`, call_id: cid } }, msg: { role: "tool", call_id: cid, content: `输出：${out}` } },
            ];
          }).flat();
          fire([
            { delay: 20, ev: { type: "Thinking", data: { session_id: sid, content: "我要连续执行三个命令验证 call_id 配对。", thought_id: "th_main_1" } } },
            { delay: 30, ev: { type: "ThinkingEnd", data: { session_id: sid, thought_id: "th_main_1" } } },
            ...steps.slice(0, 2), // run-1 + result
            // 观察 1：第一个工具后、第二个工具前（实时 flush 成 narration；落库供回放推断）
            { delay: 320, ev: { type: "Token", data: { session_id: sid, token: "第一个命令执行成功" } }, msg: { role: "assistant", content: "第一个命令执行成功" } },
            ...steps.slice(2, 4), // run-2 + result
            // 观察 2：第二个工具后、第三个工具前
            { delay: 520, ev: { type: "Token", data: { session_id: sid, token: "第二个也成功，继续" } }, msg: { role: "assistant", content: "第二个也成功，继续" } },
            ...steps.slice(4, 6), // run-3 + result
            { delay: 720, ev: { type: "Token", data: { session_id: sid, token: "三个命令都执行成功了，全部完成。" } } },
            { delay: 760, ev: { type: "Done", data: { session_id: sid, final_response: "三个命令都执行成功了，全部完成。", token_usage: 128 } }, msg: { role: "assistant", content: "三个命令都执行成功了，全部完成。" } },
          ]);
          return undefined;
        }

        // ── [two-think]：一轮内两段独立思考（G5 ThinkingEnd 分段验收）──
        // 中间夹一个工具调用：两段思考在有工具的过程流（ProcessPanel）里分两行呈现；
        // 纯问答轮现在也统一走 ProcessPanel「查看过程」，本例验证工具轮内的分段。
        if (content.includes("[two-think]")) {
          fire([
            { delay: 40, ev: { type: "Thinking", data: { session_id: sid, content: "第一段思考：先分析需求，拆解步骤。", thought_id: "th_main_1" } } },
            { delay: 80, ev: { type: "Thinking", data: { session_id: sid, content: "这一步要小心边界条件。", thought_id: "th_main_1" } } },
            { delay: 120, ev: { type: "ThinkingEnd", data: { session_id: sid, thought_id: "th_main_1" } } },
            { delay: 160, ev: { type: "ToolCall", data: { session_id: sid, tool_name: "run_command", tool_args: JSON.stringify({ cmd: "echo 检查" }), call_id: "t1" } }, msg: { role: "assistant", tool_name: "run_command", tool_args: JSON.stringify({ cmd: "echo 检查" }), call_id: "t1", content: "" } },
            { delay: 220, ev: { type: "ToolResult", data: { session_id: sid, tool_name: "run_command", result: "检查完成", call_id: "t1" } }, msg: { role: "tool", call_id: "t1", content: "检查完成" } },
            { delay: 260, ev: { type: "Thinking", data: { session_id: sid, content: "第二段思考：开始组织最终输出。", thought_id: "th_main_2" } } },
            { delay: 300, ev: { type: "ThinkingEnd", data: { session_id: sid, thought_id: "th_main_2" } } },
            { delay: 340, ev: { type: "Token", data: { session_id: sid, token: "两段思考已完成。" } } },
            { delay: 380, ev: { type: "Done", data: { session_id: sid, final_response: "两段思考已完成。", token_usage: 64 } }, msg: { role: "assistant", content: "两段思考已完成。" } },
          ]);
          return undefined;
        }

        // ── [narration]：最后一个工具后先观察再答（观察进过程、答案进气泡验收）──
        if (content.includes("[narration]")) {
          fire([
            { delay: 40, ev: { type: "ToolCall", data: { session_id: sid, tool_name: "run_command", tool_args: JSON.stringify({ cmd: "cargo test" }), call_id: "n1" } }, msg: { role: "assistant", tool_name: "run_command", tool_args: JSON.stringify({ cmd: "cargo test" }), call_id: "n1", content: "" } },
            { delay: 100, ev: { type: "ToolResult", data: { session_id: sid, tool_name: "run_command", result: "17 passed, 1 failed", call_id: "n1" } }, msg: { role: "tool", call_id: "n1", content: "17 passed, 1 failed" } },
            // 观察：工具后、下一工具前（Token 累积 → 下一个 ToolCall flush 成 narration）
            { delay: 140, ev: { type: "Token", data: { session_id: sid, token: "语法没问题，17/18 断言通过，剩一个待修。" } } },
            { delay: 180, ev: { type: "ToolCall", data: { session_id: sid, tool_name: "edit_file", tool_args: JSON.stringify({ path: "src/lib.rs" }), call_id: "n2" } }, msg: { role: "assistant", tool_name: "edit_file", tool_args: JSON.stringify({ path: "src/lib.rs" }), call_id: "n2", content: "" } },
            { delay: 240, ev: { type: "ToolResult", data: { session_id: sid, tool_name: "edit_file", result: "已修改", call_id: "n2" } }, msg: { role: "tool", call_id: "n2", content: "已修改" } },
            // 最终答案（所有工具跑完后）
            { delay: 280, ev: { type: "Token", data: { session_id: sid, token: "修复完成，全部断言通过。" } } },
            { delay: 320, ev: { type: "Done", data: { session_id: sid, final_response: "修复完成，全部断言通过。", token_usage: 200 } }, msg: { role: "assistant", content: "修复完成，全部断言通过。" } },
          ]);
          return undefined;
        }

        // ── [cot-5k]：5000 字超长 CoT（Phase 4 行钳制验收）──
        // 同样夹一个工具：超长 CoT 在有工具的过程流里触发行钳制；纯问答轮现也走 ProcessPanel。
        if (content.includes("[cot-5k]")) {
          const longCoT = "思考过程内容。".repeat(1000); // ~6000 字
          fire([
            { delay: 40, ev: { type: "Thinking", data: { session_id: sid, content: longCoT, thought_id: "th_main_1" } } },
            { delay: 80, ev: { type: "ThinkingEnd", data: { session_id: sid, thought_id: "th_main_1" } } },
            { delay: 120, ev: { type: "ToolCall", data: { session_id: sid, tool_name: "run_command", tool_args: JSON.stringify({ cmd: "echo 长思考" }), call_id: "c5" } }, msg: { role: "assistant", tool_name: "run_command", tool_args: JSON.stringify({ cmd: "echo 长思考" }), call_id: "c5", content: "" } },
            { delay: 180, ev: { type: "ToolResult", data: { session_id: sid, tool_name: "run_command", result: "完成", call_id: "c5" } }, msg: { role: "tool", call_id: "c5", content: "完成" } },
            { delay: 220, ev: { type: "Token", data: { session_id: sid, token: "超长思考已展示。" } } },
            { delay: 260, ev: { type: "Done", data: { session_id: sid, final_response: "超长思考已展示。", token_usage: 6000 } }, msg: { role: "assistant", content: "超长思考已展示。" } },
          ]);
          return undefined;
        }

        // ── [many-steps]：205 个工具步（Phase 4 长会话分片验收：>60 阈值 + >200 窗口）──
        if (content.includes("[many-steps]")) {
          const steps: Array<{ delay: number; ev: any; msg?: any }> = [];
          for (let i = 1; i <= 205; i++) {
            const cid = `step-${i}`;
            steps.push(
              { delay: i * 10, ev: { type: "ToolCall", data: { session_id: sid, tool_name: "run_command", tool_args: JSON.stringify({ cmd: `step ${i}` }), call_id: cid } }, msg: { role: "assistant", tool_name: "run_command", tool_args: JSON.stringify({ cmd: `step ${i}` }), call_id: cid, content: "" } },
              { delay: i * 10 + 4, ev: { type: "ToolResult", data: { session_id: sid, tool_name: "run_command", result: `ok ${i}`, call_id: cid } }, msg: { role: "tool", call_id: cid, content: `ok ${i}` } },
            );
          }
          fire([
            ...steps,
            { delay: 205 * 10 + 40, ev: { type: "Token", data: { session_id: sid, token: "205 步全部完成。" } } },
            { delay: 205 * 10 + 80, ev: { type: "Done", data: { session_id: sid, final_response: "205 步全部完成。", token_usage: 400 } }, msg: { role: "assistant", content: "205 步全部完成。" } },
          ]);
          return undefined;
        }

        // ── [slow-start]：模拟长 TTFT（首事件延迟 800ms）——验证「深度思考中…」
        // 占位在空窗期可见（此前被 buildTurns 剔除 → 发命令后聊天区空白）。──
        if (content.includes("[slow-start]")) {
          if (typeof console !== "undefined") console.log("[mock] slow-start hit");
          fire([
            { delay: 800, ev: { type: "Thinking", data: { session_id: sid, content: "开始思考。", thought_id: "th_main_1" } } },
            { delay: 860, ev: { type: "ThinkingEnd", data: { session_id: sid, thought_id: "th_main_1" } } },
            { delay: 920, ev: { type: "Token", data: { session_id: sid, token: "思考完成。" } } },
            { delay: 980, ev: { type: "Done", data: { session_id: sid, final_response: "思考完成。", token_usage: 16 } }, msg: { role: "assistant", content: "思考完成。" } },
          ]);
          return undefined;
        }

        // ── [compaction-slow]：模拟压缩上下文阶段耗时，验证中断与本轮继续 ──
        // 先发射「压缩上下文中」thinking 并长时间挂起，随后才给答案；cancel_agent
        // 会清理剩余定时器并 emit Error，让 UI 从 loading 恢复。
        if (content.includes("[compaction-slow]")) {
          if (typeof console !== "undefined") console.log("[mock] compaction-slow hit");
          fire([
            { delay: 100, ev: { type: "Thinking", data: { session_id: sid, content: "压缩上下文中", thought_id: "th_main_1" } } },
            { delay: 3000, ev: { type: "ThinkingEnd", data: { session_id: sid, thought_id: "th_main_1" } } },
            { delay: 3060, ev: { type: "Token", data: { session_id: sid, token: "压缩完成，继续回答。" } } },
            { delay: 3120, ev: { type: "Done", data: { session_id: sid, final_response: "压缩完成，继续回答。", token_usage: 32 } }, msg: { role: "assistant", content: "压缩完成，继续回答。" } },
          ]);
          return undefined;
        }

        // ── [file-edit]：文件编辑工具（WorkBuddy 风格行动叙述验收）──
        // edit_file + 带 diff 统计的结果 → 工具行渲染「可点击文件名 + +N −M」。
        // 复制 WorkBuddy 设计：动作 + 文件名链接（点击用系统程序打开）+ 改动行数。
        if (content.includes("[file-edit]")) {
          fire([
            { delay: 40, ev: { type: "Thinking", data: { session_id: sid, content: "我要调整 ProcessPanel 的渲染逻辑。", thought_id: "th_main_1" } } },
            { delay: 80, ev: { type: "ThinkingEnd", data: { session_id: sid, thought_id: "th_main_1" } } },
            { delay: 120, ev: { type: "ToolCall", data: { session_id: sid, tool_name: "edit_file", tool_args: JSON.stringify({ path: "src/components/ProcessPanel.tsx" }), call_id: "fe1" } }, msg: { role: "assistant", tool_name: "edit_file", tool_args: JSON.stringify({ path: "src/components/ProcessPanel.tsx" }), call_id: "fe1", content: "" } },
            { delay: 200, ev: { type: "ToolResult", data: { session_id: sid, tool_name: "edit_file", result: "Successfully wrote 1234 bytes to src/components/ProcessPanel.tsx (+3 - 2 lines)", call_id: "fe1" } }, msg: { role: "tool", call_id: "fe1", content: "Successfully wrote 1234 bytes to src/components/ProcessPanel.tsx (+3 - 2 lines)" } },
            { delay: 240, ev: { type: "Token", data: { session_id: sid, token: "已修改完成。" } } },
            { delay: 280, ev: { type: "Done", data: { session_id: sid, final_response: "已修改完成。", token_usage: 50 } }, msg: { role: "assistant", content: "已修改完成。", reasoning_content: "我要调整 ProcessPanel 的渲染逻辑。" } },
          ]);
          return undefined;
        }

        // ── [mid-error]：执行中途整轮报错（Error 事件中断）──
        // 验证「思考执行过程中整轮报错会立即收起」：Error 处理器 setIsStreaming(false)
        // → live=false → ProcessPanel 切 done 折叠态（「已出错 · 查看过程」）。
        if (content.includes("[mid-error]")) {
          fire([
            { delay: 40, ev: { type: "Thinking", data: { session_id: sid, content: "我先跑个命令探测环境。", thought_id: "th_main_1" } } },
            { delay: 80, ev: { type: "ThinkingEnd", data: { session_id: sid, thought_id: "th_main_1" } } },
            { delay: 120, ev: { type: "ToolCall", data: { session_id: sid, tool_name: "run_command", tool_args: JSON.stringify({ cmd: "ls /secret" }), call_id: "e1" } }, msg: { role: "assistant", tool_name: "run_command", tool_args: JSON.stringify({ cmd: "ls /secret" }), call_id: "e1", content: "" } },
            { delay: 200, ev: { type: "ToolResult", data: { session_id: sid, tool_name: "run_command", result: "权限拒绝", call_id: "e1", is_error: true } }, msg: { role: "tool", call_id: "e1", content: "权限拒绝" } },
            // 整轮中断：模拟引擎抛错终止本轮（不是单工具失败，isStreaming 被翻 false）
            { delay: 360, ev: { type: "Error", data: { session_id: sid, message: "执行失败：内核连接超时" } } },
          ]);
          return undefined;
        }

        // ── [answer-collapse]：⚠️ 2026-08-17 起该标记语义已变更 ──
        // 旧用途：answering（streamMode=answer）触发 shouldCollapse → 答题即收起过程流。
        // 现 shouldCollapse 只看 `!live && effectivelyDone`，answering 不再驱动折叠，
        // 故答题期间过程流保持展开（避免 live↔done 闪烁）。若仍想验证「回合结束才收起」，
        // 用 [finish] 等真正结束事件触发，而非此处 answer phase。
        if (content.includes("[answer-collapse]")) {
          const reasoning =
            "我先梳理一下任务目标，再分步骤分析实现路径，中间会检查边界条件并验证假设，最后组织结论。";
          const answer =
            "这是经过完整思考后给出的总结：已确认需求边界、核对了依赖关系、验证了关键假设，现在可以给出最终结论，整体方案可行且风险可控。";
          fire([
            { delay: 40, ev: { type: "Thinking", data: { session_id: sid, content: reasoning, thought_id: "th_main_1" } } },
            { delay: 80, ev: { type: "ThinkingEnd", data: { session_id: sid, thought_id: "th_main_1" } } },
            // 答案 token（>25 字）→ streamMode 立即切到 answer；Done 刻意延迟，
            // 制造「答案流式输出期间」窗口，验证此时过程流已收起而非仍展开。
            { delay: 200, ev: { type: "Token", data: { session_id: sid, token: answer } } },
            { delay: 1600, ev: { type: "Done", data: { session_id: sid, final_response: answer, token_usage: 128 } }, msg: { role: "assistant", content: answer, reasoning_content: reasoning } },
          ]);
          return undefined;
        }

        // ── [internal-tools]：只调用内部工具（read_memory / list_agents）后给出答案──
        // 验证 collapsed 密度下内部工具被折叠后，过程流容器/「查看过程」入口不消失：
        // 策略层把内部工具在 done+collapsed 下隐藏 → displayDecisions 为空，
        // 但 items.length > 0，所以 ProcessPanel 仍应渲染「已完成 · 查看过程」。
        if (content.includes("[internal-tools]")) {
          fire([
            { delay: 40, ev: { type: "ToolCall", data: { session_id: sid, tool_name: "read_memory", tool_args: JSON.stringify({ block: "USER" }), call_id: "im1" } }, msg: { role: "assistant", tool_name: "read_memory", tool_args: JSON.stringify({ block: "USER" }), call_id: "im1", content: "" } },
            { delay: 100, ev: { type: "ToolResult", data: { session_id: sid, tool_name: "read_memory", result: "用户画像内容", call_id: "im1" } }, msg: { role: "tool", call_id: "im1", content: "用户画像内容" } },
            { delay: 140, ev: { type: "ToolCall", data: { session_id: sid, tool_name: "list_agents", tool_args: JSON.stringify({}), call_id: "im2" } }, msg: { role: "assistant", tool_name: "list_agents", tool_args: JSON.stringify({}), call_id: "im2", content: "" } },
            { delay: 200, ev: { type: "ToolResult", data: { session_id: sid, tool_name: "list_agents", result: "[agent-1, agent-2]", call_id: "im2" } }, msg: { role: "tool", call_id: "im2", content: "[agent-1, agent-2]" } },
            { delay: 260, ev: { type: "Token", data: { session_id: sid, token: "已读取记忆并列出可用 agent。" } } },
            { delay: 320, ev: { type: "Done", data: { session_id: sid, final_response: "已读取记忆并列出可用 agent。", token_usage: 32 } }, msg: { role: "assistant", content: "已读取记忆并列出可用 agent。" } },
          ]);
          return undefined;
        }

        // ── 默认 / [blank]：保留既有思考流（thinking.spec.ts 依赖）──
        if (isBlank) {
          // 空白 reasoning（应被 ThinkingBlock 拦截）+ 真实回答
          fire([
            { delay: 60, ev: { type: "Thinking", data: { session_id: sid, content: "   \n  " } } },
            { delay: 200, ev: { type: "Token", data: { session_id: sid, token: "好的" } } },
            { delay: 450, ev: { type: "Done", data: { session_id: sid, final_response: "好的", token_usage: 1 } }, msg: { role: "assistant", content: "好的" } },
          ]);
        } else {
          // reasoning 必须 > THINK_HINT_THRESHOLD(240) 才会在 ThinkingLayer auto 模式下渲染。
          const reasoning =
            "让我先分析一下：这是一个验证纯思考流的测试。我需要确认组件链路完整，思考过程能被正确渲染而不是空白框。" +
            "思考会经历多个阶段：先拆解用户意图，再检查组件状态，然后逐步验证渲染链路，最后才组织输出。" +
            "每一步都可能遇到边界条件，需要仔细推敲。这个过程本身是模型推理的真实展示，用户应当能在界面上看到完整的思考轨迹。" +
            "只有当思考层正确渲染时，用户才能理解模型为什么这样回答。所以这个测试专门验证长推理链的可见性。" +
            "为了确保测试稳定，我把推理链写得足够长，超过自动模式的阈值，这样无论组件内部如何优化，思考内容都会被渲染出来。" +
            "推理的每个环节都值得展示：理解问题、规划方案、检查依赖、验证假设、得出结论。这是一条完整的思维路径。" +
            "现在思考已经非常充分，可以开始组织最终答案了。";
          const answer = "验证完成：思考过程已正常显示，没有空白框。";
          fire([
            { delay: 60, ev: { type: "Thinking", data: { session_id: sid, content: reasoning } } },
            { delay: 200, ev: { type: "Token", data: { session_id: sid, token: answer } } },
            { delay: 450, ev: { type: "Done", data: { session_id: sid, final_response: answer, token_usage: 128 } }, msg: { role: "assistant", content: answer, reasoning_content: reasoning } },
          ]);
        }
        return undefined;
      }
      // 启动进度：mock 视为已就绪（100），splash 在最短展示时间后淡出进入。
      case "startup_progress":
        return 100;

      // settings / config
      case "get_config_api_key":
        return "";
      case "set_config_api_key":
        return undefined;
      case "get_setting":
        return localStorage.getItem("mock_setting_" + args.key) ?? "";
      case "set_setting":
        localStorage.setItem("mock_setting_" + args.key, args.value ?? "");
        return undefined;
      case "approve_tool":
      case "set_auto_approve":
        return undefined;
      case "cancel_agent": {
        const sid = args.sessionId as string;
        const run = activeRuns[sid];
        if (run) {
          run.cancelled = true;
          run.timers.forEach((id) => window.clearTimeout(id));
          run.timers = [];
        }
        // 模拟后端 cancel 后 emit Error 事件（与真实引擎行为一致），让 UI 停 loading。
        window.setTimeout(() => {
          emit("agent-event", { type: "Error", data: { session_id: sid, message: "已取消", error_code: "CANCELLED", retriable: false } });
        }, 20);
        return undefined;
      }
      // R3 审批：approvalBroker decide（四态就地卡片）
      case "decide_approval":
        return undefined;
      // T1：批量四态决策（"本轮全部批准"）。返回被决策的 id 列表（前端据此移除）。
      case "decide_approval_batch":
        return args.ids ?? [];
      // T1：会话级工具豁免（"此工具本次会话不再问"），不落库。
      case "exempt_tool_for_session":
        return undefined;

      // mcp / skills
      case "list_mcp_servers":
        return [];
      case "add_mcp_server":
        return { id: uid(), name: args.name ?? "mcp", enabled: true, config: {} };
      case "set_mcp_enabled":
      case "delete_mcp_server":
        return undefined;
      case "test_mcp_connection":
        return { ok: true, capabilities: { tools: ["mcp__tavily__web_search"], resources: [] }, message: "mock" };
      // 联网工具（Web Tools）开关 + 搜索 Provider + 搜索 Key
      case "get_web_tools_config": {
        const activeKey = mockWebSearchProvider === "brave" ? mockBraveKey : mockTavilyKey;
        return { enabled: mockWebToolsEnabled, provider: mockWebSearchProvider, hasKey: activeKey.length > 0 };
      }
      case "set_web_tools_enabled":
        mockWebToolsEnabled = args.enabled === true;
        return undefined;
      case "get_search_provider":
        return mockWebSearchProvider;
      case "set_search_provider":
        mockWebSearchProvider = args.provider === "brave" ? "brave" : "tavily";
        return undefined;
      case "get_active_search_key":
        return mockWebSearchProvider === "brave" ? mockBraveKey : mockTavilyKey;
      case "set_active_search_key": {
        if (mockWebSearchProvider === "brave") mockBraveKey = args.key ?? "";
        else mockTavilyKey = args.key ?? "";
        return undefined;
      }
      case "list_skills":
        return [];
      case "add_skill":
      case "import_skill_local":
      case "import_skill_url":
        return { id: uid(), name: args.name ?? "skill", enabled: true, capabilities: [] };
      case "set_skill_enabled":
      case "delete_skill":
        return undefined;
      case "set_skill_budget":
        return undefined;
      case "get_skill_budget":
        return { token_limit: null, cost_cents_limit: null, time_secs_limit: null };
      case "diagnose_capabilities":
        return [];

      // scheduled tasks（侧栏「定时任务」入口）
      case "list_scheduled_tasks":
        return scheduledTasks;
      case "create_scheduled_task":
        return { id: uid(), name: args.name ?? "task", cron: args.cron ?? "", enabled: true, prompt: args.prompt ?? "", created_at: now };
      case "update_scheduled_task":
        return {
          id: args.id ?? uid(),
          title: args.title ?? "task",
          description: args.description ?? null,
          type_: args.type_ ?? "cron",
          schedule: args.schedule ?? { cron: "0 2 * * *", once: null, interval: null },
          source: args.source ?? "agent_dialog",
          status: "active",
          action_type: args.action_type ?? "agent",
          action_payload: args.action_payload ?? "",
          created_at: now,
          updated_at: now,
          last_run_at: null,
          next_run_at: null,
          run_count: 0,
        };
      case "set_task_paused":
      case "delete_scheduled_task":
      case "run_task_now":
        return undefined;

      // 长任务：暂停 / 续跑 / 进度 / 恢复面板（作用于 runs 执行实例）。
      // 默认「无中断可恢复」，恢复面板渲染空态；需要非空场景的用例自行覆写
      // window.__mockLongTaskInterruptions。
      case "list_interruptions":
        return (window as any).__mockLongTaskInterruptions ?? [];
      case "get_task_checkpoint":
        return (window as any).__mockLongTaskCheckpoint ?? null;
      case "pause_task":
        // true = 暂停信号已送达；false = 该会话本就没有运行中的 run。
        return true;
      case "resume_task": {
        // 续跑成功后从可恢复列表移除该条（模拟后端 mark_superseded），让面板即时清空。
        const arr: any[] = (window as any).__mockLongTaskInterruptions ?? [];
        const idx = arr.findIndex(
          (r) =>
            r.run_id === args.runId ||
            r.job_id === args.jobId ||
            r.session_id === (args.sessionId ?? args.session_id),
        );
        if (idx >= 0) arr.splice(idx, 1);
        return args.sessionId ?? args.session_id ?? "session-resumed";
      }

      // agent presets
      case "list_agent_presets":
        return presets;
      case "create_agent_preset": {
        // 与真实后端同构：单 struct 参数命令必须经 { payload } 传参（tauri.ts 已统一）。
        const pl = args.payload ?? args;
        const p = { id: uid(), name: pl.name, model: pl.model ?? "deepseek-chat", system_prompt: pl.system_prompt ?? "", capabilities: pl.capabilities ?? [], skills: [], mcp: [], tools: [], created_at: now };
        presets.push(p);
        return p;
      }
      // F4 Agent 定义可移植：本地扫描 / 导入 / 导出 / 删除。
      case "scan_local_agents": {
        // 返回 home + workspace 各一条入口，让导入弹窗在浏览器 harness 下也能渲染列表。
        return [
          { name: "local-reviewer", path: "~/.claude/agents/local-reviewer.md", source: "home" },
          { name: "local-coder", path: "./.claude/agents/local-coder.md", source: "workspace" },
        ];
      }
      case "import_agent": {
        const base = (args.path ?? "imported").split("/").pop()?.replace(/\.md$/, "") ?? "imported";
        const p = { id: uid(), name: base, model: "deepseek-chat", system_prompt: "（从本地 Agent 导入）", capabilities: [], skills: [], mcp: [], tools: [], created_at: now };
        presets.push(p);
        return p;
      }
      case "export_agent":
        // 返回导出文件路径字符串（前端据此展示导出成功提示）。
        return "/tmp/onedesktop-mock/agent-exports/" + (args.id ?? "agent") + ".md";
      case "delete_agent_preset":
        return undefined;

      // groups
      case "list_groups":
        return groups;
      case "get_group":
        return groups.find((g) => g.id === args.id) ?? null;
      // R6：竞速备选 mock（前端 GroupRoundtable 加载时调；当前返回空=无竞速数据）
      case "group_list_alternatives":
        return [];
      case "group_pick_alternative": {
        return {
          seq: 1,
          group_id: args.group_id ?? args.groupId,
          author: "",
          worker_id: "",
          author_kind: "system",
          content: "[改选] mock",
          mentions: [],
          attachments: [],
          created_at: Date.now(),
        };
      }
      case "create_group": {
        // 与真实后端同构：单 struct 参数命令必须经 { payload } 传参（tauri.ts 已统一）。
        const pl = args.payload ?? args;
        // V5.1：与后端同构的结构化错误（空名 → {code, message} JSON 对象）
        if (!pl.name || !String(pl.name).trim()) {
          throw { code: "UNKNOWN", message: "name is required" };
        }
        const g = {
          id: uid(),
          name: pl.name,
          goal: pl.goal ?? "",
          owner_agent_ref: pl.owner_agent_ref ?? pl.ownerAgentRef ?? "p_researcher",
          status: "Draft",
          seat_config: pl.seat_config ?? pl.seatConfig ?? {},
          created_at: Date.now(),
        };
        groups.push(g);
        workers[g.id] = [];
        tasks[g.id] = [];
        messages[g.id] = [];
        summaries[g.id] = [];
        return g;
      }
      case "group_topology_get": {
        // 无快照 → 回退 deny-all（与后端 TopologyPolicy::default() 同构）。
        const snap = topologySnapshots[(args.group_id ?? args.groupId)];
        return snap ?? { version: 1, default: "Deny", edges: [] };
      }
      case "group_topology_set": {
        const gid = args.group_id ?? args.groupId;
        const prev = topologySnapshots[gid]?.version ?? 0;
        const next = { ...(args.policy ?? {}), version: prev + 1 };
        topologySnapshots[gid] = next;
        return next.version;
      }
      case "group_blackboard_get": {
        const gid = args.group_id ?? args.groupId;
        const board = blackboardSnapshots[gid] ?? {};
        const entries = Object.entries(board).map(([key, v]) => ({
          key,
          value: v.value,
          version: v.version,
        }));
        return { group_id: gid, entries };
      }
      case "group_blackboard_set": {
        const gid = args.group_id ?? args.groupId;
        const key = args.key;
        const expected = Number(args.expected_version ?? args.expectedVersion ?? 0);
        const board = (blackboardSnapshots[gid] ||= {});
        const cur = board[key]?.version ?? 0;
        if (cur !== expected) {
          throw new Error(
            `版本冲突：期望版本 ${expected}，当前已是版本 ${cur}。请先读取最新值再更新。`,
          );
        }
        const nextVersion = cur + 1;
        board[key] = { value: String(args.value ?? ""), version: nextVersion };
        return nextVersion;
      }
      case "group_add_worker": {
        const w = { id: uid(), group_id: (args.group_id ?? args.groupId), agent_ref: args.agent_ref, seat_type: "Static", status: "Idle", max_concurrency: 1, capabilities: args.capabilities ?? [], current_task_id: null, last_heartbeat: Date.now() };
        (workers[(args.group_id ?? args.groupId)] ||= []).push(w);
        return w;
      }
      case "group_list_workers":
        // deep clone so React detects a new reference on every fetch (mutations
        // below would otherwise leave the same identity and skip re-render).
        return JSON.parse(JSON.stringify(workers[(args.group_id ?? args.groupId)] ?? []));
      case "group_add_capability_seat": {
        const w = {
          id: uid(),
          group_id: (args.group_id ?? args.groupId),
          agent_ref: "",
          seat_type: "Capability",
          status: "Offline",
          max_concurrency: args.max_concurrency ?? 1,
          capabilities: args.capabilities ?? [],
          current_task_id: null,
          last_heartbeat: Date.now(),
        };
        (workers[(args.group_id ?? args.groupId)] ||= []).push(w);
        return w;
      }
      case "group_set_worker_status": {
        const list = workers[(args.group_id ?? args.groupId)] || [];
        const w = list.find((x: any) => x.id === (args.worker_id ?? args.workerId));
        if (w) w.status = args.status === "offline" ? "Offline" : "Idle";
        return undefined;
      }
      case "group_set_worker_agent": {
        const list = workers[(args.group_id ?? args.groupId)] || [];
        const w = list.find((x: any) => x.id === (args.worker_id ?? args.workerId));
        if (w) {
          w.agent_ref = args.agent_ref ?? args.agentRef;
          // 重绑来源 Agent 时同步能力（mock：从预设找能力，找不到用空）
          w.capabilities = args.capabilities ?? [];
        }
        return w ? JSON.parse(JSON.stringify(w)) : null;
      }
      case "group_remove_worker": {
        const gid = args.group_id ?? args.groupId;
        const wid = args.worker_id ?? args.workerId;
        const list = workers[gid] || [];
        const idx = list.findIndex((x: any) => x.id === wid);
        if (idx >= 0) {
          list.splice(idx, 1);
          emit("group-event", { type: "worker_removed", group_id: gid, worker_id: wid });
        }
        return undefined;
      }
      case "group_list_tasks": {
        const all = tasks[(args.group_id ?? args.groupId)] ?? [];
        return args.batchId ? all.filter((t) => t.batch_id === args.batchId) : all;
      }
      // 全局看板：跨群聚合全部任务（mock 下把所有群的 tasks 拍平）。
      case "task_list_all": {
        return Object.values(tasks).flat();
      }
      // 手动新建任务（看板「新建任务」入口）。mock 下落到第一个已知群（或 personal）。
      case "task_create": {
        const gid = args.payload?.group_id || "personal";
        const t = {
          id: "task-" + Math.random().toString(36).slice(2, 10),
          group_id: gid,
          batch_id: null,
          worker_id: null,
          description: args.payload?.description ?? "新任务",
          depends_on: args.payload?.depends_on ?? [],
          input_refs: [],
          output_spec: null,
          status: "Pending",
          retry_count: 0,
          assigned_worker: null,
          outputs: [],
          reasoning: args.payload?.reasoning ?? null,
          capability: args.payload?.capability ?? null,
          last_heartbeat: null,
        };
        (tasks[gid] ??= []).push(t);
        return t;
      }
      case "group_list_worker_metrics": {
        // 返回该群 Worker 的指标快照（mock 下给空列表即可，避免 createGroups 页面 for..of undefined 抛错）。
        return metrics[(args.group_id ?? args.groupId)] ?? [];
      }
      case "group_list_deliverables": {
        return deliverables[(args.group_id ?? args.groupId)] ?? [];
      }
      // P1 溯源下钻：返回该 session 的合成 ReAct 轨迹。
      // 字段形状严格对齐真实后端 TraceDto（src-tauri/src/types.rs::TraceDto），
      // 且 kind 取值对齐 traceToItems 的 switch（user/thinking/intent/tool_call/
      // tool_result/answer/observation/notice）——否则前端会全部丢成空壳、测试假阳性。
      case "get_trace": {
        const sid = args.sessionId ?? args.session_id ?? "";
        const iso = (delta: number) => new Date(now + delta).toISOString();
        return [
          {
            id: 1, session_id: sid, scene: "worker", agent_type: "worker",
            kind: "user", name: null, seq: 1, call_id: null, parent_id: null,
            content: "请对三款竞品做功能与定价对比。", args: null, result: null,
            reasoning: null, is_error: null, started_at: null, ended_at: null,
            created_at: iso(-9000),
          },
          {
            id: 2, session_id: sid, scene: "worker", agent_type: "worker",
            kind: "tool_call", name: "web_search", seq: 2, call_id: "t1",
            parent_id: null, content: null, args: JSON.stringify({ query: "竞品对比" }),
            result: null, reasoning: null, is_error: null, started_at: null,
            ended_at: null, created_at: iso(-7000),
          },
          {
            id: 3, session_id: sid, scene: "worker", agent_type: "worker",
            kind: "tool_result", name: "web_search", seq: 3, call_id: "t1",
            parent_id: null, content: "A 功能最全；B 定价灵活；C 适合中小团队。",
            args: null, result: "A 功能最全；B 定价灵活；C 适合中小团队。",
            reasoning: null, is_error: false, started_at: null, ended_at: null,
            created_at: iso(-6000),
          },
          {
            id: 4, session_id: sid, scene: "worker", agent_type: "worker",
            kind: "answer", name: null, seq: 4, call_id: null, parent_id: null,
            content:
              "# 竞品分析初稿\n\n## A 产品\n- 功能最全\n- 适合企业\n\n## B 产品\n- 定价灵活\n- 订阅制",
            args: null, result: null, reasoning: null, is_error: null,
            started_at: null, ended_at: null, created_at: iso(-5000),
          },
        ];
      }

      // 产出物预览（docs/design/deliverable-preview-arch.md）：受控文件内容通道。
      // mock 按扩展名返回示例文本；真实后端才做 scope 校验（cargo 单测覆盖），
      // 此处作为测试替身放行任意路径，以覆盖「用户自选工作区」等动态 scope 场景。
      case "artifact_read_text": {
        const p = (args.path as string) || "";
        if (p.endsWith(".csv") || p.endsWith(".tsv")) {
          const csv = "name,score\nA,90\nB,85\nC,78";
          return { content: csv, size: csv.length };
        }
        if (p.endsWith(".html") || p.endsWith(".htm")) {
          const html = "<h1>Mock HTML</h1><p>hello preview</p>";
          return { content: html, size: html.length };
        }
        if (p.endsWith(".md") || p.endsWith(".markdown")) {
          const md = "# Mock\n\ncontent from file";
          return { content: md, size: md.length };
        }
        const content = "mock file content for " + p;
        return { content, size: content.length };
      }

      // 图片/二进制内嵌通道：返回 1x1 透明 PNG 的 base64，供 <img data URL> 渲染。
      case "artifact_read_base64": {
        const p = (args.path as string) || "";
        const ext = p.split(".").pop()?.toLowerCase() ?? "";
        const mime =
          ext === "png"
            ? "image/png"
            : ext === "jpg" || ext === "jpeg"
              ? "image/jpeg"
              : ext === "gif"
                ? "image/gif"
                : ext === "webp"
                  ? "image/webp"
                  : ext === "svg"
                    ? "image/svg+xml"
                    : ext === "pdf"
                      ? "application/pdf"
                      : "application/octet-stream";
        const tinyPng =
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
        return { mime, data: tinyPng, size: tinyPng.length };
      }

      // 全局「产出文件」浏览器：mock 返回若干样本条目（覆盖不同扩展名/MIME），
      // 让前端列表与点击预览链路在 E2E 下可走通。
      case "list_model_files": {
        const sample = (name: string, mime: string, size: number, mtime: number) => ({
          path: `/Users/test/.onedesktop/workspaces/default/${name}`,
          name,
          size,
          mtime,
          mime,
        });
        return [
          sample("report.md", "text/markdown", 2048, 1700000000000),
          sample("chart.png", "image/png", 12345, 1700000100000),
          sample("data.csv", "text/csv", 512, 1700000200000),
          sample("notes.txt", "text/plain", 256, 1700000300000),
        ];
      }

      // 文件树（侧栏「资源」导航接管对话区 → SidebarFileTree）：返回嵌套树，
      // 根节点为工作区目录（default），含一个子目录 docs 与若干文件，覆盖不同
      // 扩展名/MIME，让折叠与点击预览链路在 E2E 下可走通。
      case "list_workspace_file_tree": {
        const ws = (p: string) => `/Users/test/.onedesktop/workspaces/default/${p}`;
        return [
          {
            name: "default",
            path: "/Users/test/.onedesktop/workspaces/default",
            is_dir: true,
            size: null,
            mtime: null,
            mime: null,
            children: [
              {
                name: "docs",
                path: ws("docs"),
                is_dir: true,
                size: null,
                mtime: null,
                mime: null,
                children: [
                  { name: "report.md", path: ws("docs/report.md"), is_dir: false, size: 2048, mtime: 1700000000000, mime: "text/markdown" },
                ],
              },
              { name: "chart.png", path: ws("chart.png"), is_dir: false, size: 12345, mtime: 1700000100000, mime: "image/png" },
              { name: "data.csv", path: ws("data.csv"), is_dir: false, size: 512, mtime: 1700000200000, mime: "text/csv" },
              { name: "notes.txt", path: ws("notes.txt"), is_dir: false, size: 256, mtime: 1700000300000, mime: "text/plain" },
            ],
          },
        ];
      }

      // R4/R5 运行洞察：mock 下无历史运行，返回空聚合（前端对空集正常渲染空态）。
      case "insight_group_runs": {
        return {
          summary: { run_count: 0, prompt_tokens: 0, output_tokens: 0, total_duration_ms: 0, est_cost_yuan: 0 },
          runs: [],
        };
      }
      case "insight_seat_runs": {
        return {
          summary: { total_runs: 0, success_runs: 0, total_tokens: 0, total_duration_ms: 0, est_cost_yuan: 0 },
          recent_runs: [],
        };
      }
      // IX-14 回放导出：mock 下无运行记录 → 报错（与真实空群行为一致，前端显示导出失败提示）。
      case "export_run_replay": {
        return Promise.reject("该群还没有运行记录，无可导出的回放（mock）");
      }

      // F14 记忆分层：蒸馏 mock 直接返回成功（不触发 LLM）；检索返回空命中。
      case "memory_distill": {
        return "（mock）已蒸馏并写入项目记忆";
      }
      case "memory_search": {
        return [];
      }

      // 用户画像（设置 → 个性化）：mock 下读为空、写为无操作成功。
      case "user_profile_read": {
        return "";
      }
      case "user_profile_write": {
        return null;
      }

      // F9 Playbook：mock 下无历史 Playbook；save/delete 为无操作成功。
      case "playbook_list": {
        return [];
      }
      case "playbook_save": {
        return {
          id: uid(),
          name: args.payload?.name ?? "playbook",
          steps: args.payload?.steps ?? [],
          success_criteria: args.payload?.success_criteria ?? null,
          guardrails: args.payload?.guardrails ?? null,
          source_run_id: args.payload?.source_run_id ?? null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
      }
      case "playbook_delete": {
        return undefined;
      }

      // IX-10 变更集审阅：mock 下无写入变更 → 空汇总；回滚直接成功。
      case "group_changesets": {
        return [];
      }
      case "session_changesets": {
        // 会话级变更集（SessionChangesetPanel）：mock 无写入 → 空，否则 undefined.length 崩页。
        return [];
      }
      case "changeset_rollback": {
        return "（mock）已回滚";
      }

      // R7 单聊升级为群：propose 返回空提议（无 LLM）；confirm 直接建群并入组。
      case "session_upgrade_propose": {
        return { title: "", goal: "", seats: [], tasks: [], est_calls: 0, est_tokens: 0 };
      }
      case "session_confirm_upgrade": {
        const g = {
          id: uid(),
          name: args.title ?? "升级群",
          goal: args.goal ?? "",
          owner_agent_ref: args.owner_agent_ref ?? args.ownerAgentRef ?? "p_researcher",
          status: "Active",
          seat_config: {},
          created_at: Date.now(),
        };
        groups.push(g);
        workers[g.id] = [];
        tasks[g.id] = [];
        messages[g.id] = [];
        summaries[g.id] = [];
        // 升级把历史消息灌为群共享种子：mock 落一条 system 标记
        messages[g.id].push({
          seq: 1,
          group_id: g.id,
          author: "system",
          author_kind: "system",
          content: "（单聊升级为群，历史已迁移为群共享种子）",
          mentions: [],
          created_at: Date.now(),
        });
        return g;
      }
      case "session_fold_to_chat":
        return undefined;
      case "group_assign_tasks": {
        const batchId = uid();
        const created = (args.tasks ?? []).map((s: any) => ({
          id: s.id ?? uid(),
          group_id: (args.group_id ?? args.groupId),
          batch_id: batchId,
          worker_id: s.worker_id ?? s.workerId ?? null,
          description: s.description,
          depends_on: s.depends_on ?? s.dependsOn ?? [],
          input_refs: s.input_refs ?? s.inputRefs ?? [],
          output_spec: s.output_spec ?? s.outputSpec ?? null,
          status: "Pending",
          retry_count: 0,
          assigned_worker: null,
          outputs: [],
        }));
        (tasks[(args.group_id ?? args.groupId)] ||= []).push(...created);
        // simulate worker execution completing the batch
        setTimeout(() => {
          created.forEach((t: any) => (t.status = "Completed"));
          emit("group-event", { type: "batch_completed", group_id: (args.group_id ?? args.groupId), batch_id: batchId, terminal_count: created.length });
        }, 400);
        return batchId;
      }
      case "group_cancel_batch":
        return undefined;
      // F6 恢复动作：mock 下直接把任务重置为 Pending 并回写内存态（便于前端任务板即时刷新）。
      case "task_retry": {
        const gid = (args.group_id ?? args.groupId);
        const t = (tasks[gid] ?? []).find((x) => x.id === args.taskId);
        if (t) {
          t.status = "Pending";
          t.retry_count = (t.retry_count ?? 0) + 1;
          t.last_heartbeat = null;
        }
        return t;
      }
      case "task_reassign": {
        const gid = (args.group_id ?? args.groupId);
        const t = (tasks[gid] ?? []).find((x) => x.id === args.taskId);
        if (t) {
          t.worker_id = args.workerId ?? null;
          t.status = "Pending";
          t.last_heartbeat = null;
        }
        return t;
      }
      case "task_skip_dependency": {
        const gid = (args.group_id ?? args.groupId);
        const t = (tasks[gid] ?? []).find((x) => x.id === args.taskId);
        if (t) {
          t.depends_on = [];
          t.status = "Pending";
          t.last_heartbeat = null;
        }
        return t;
      }
      // 看板人工改状态：mock 下直接回写内存态（前端 loadDetail 后经 group_list_tasks 读回）。
      case "task_set_status": {
        const gid = (args.group_id ?? args.groupId);
        const t = (tasks[gid] ?? []).find((x) => x.id === args.taskId);
        if (t && args.status) {
          t.status = args.status;
          if (args.status === "Pending") t.last_heartbeat = null;
        }
        return t;
      }
      case "task_reorder": {
        // 看板列内拖拽重排（mock：保证返回不崩，粗略重排同群列表即可）。
        const gid = (args.group_id ?? args.groupId);
        const list = tasks[gid] ?? [];
        const t = list.find((x) => x.id === args.taskId);
        if (t && typeof args.beforeId === "string") {
          const from = list.findIndex((x) => x.id === args.taskId);
          const to = list.findIndex((x) => x.id === args.beforeId);
          if (from >= 0 && to >= 0 && from !== to) {
            const [moved] = list.splice(from, 1);
            list.splice(to, 0, moved);
            t.order_idx = to;
          }
        }
        return t;
      }
      case "group_get_workspace":
        return "/tmp/onedesktop-mock-workspace";
      case "workspace_reveal":
        // mock: no-op (testing前端 UI 即可，无需真打开文件管理器)
        return null;
      case "group_post_message": {
        const m = { seq: ++msgSeq, group_id: (args.group_id ?? args.groupId), author: "p_researcher", author_kind: "owner", content: args.content, mentions: args.mentions ?? [], created_at: Date.now() };
        (messages[(args.group_id ?? args.groupId)] ||= []).push(m);
        return m;
      }
      case "group_roundtable_broadcast": {
        const m = { seq: ++msgSeq, group_id: (args.group_id ?? args.groupId), author: "p_researcher", author_kind: "owner", content: args.content, mentions: args.mentions ?? [], created_at: Date.now() };
        (messages[(args.group_id ?? args.groupId)] ||= []).push(m);
        return m;
      }
      case "group_list_messages":
        return messages[(args.group_id ?? args.groupId)] ?? [];
      case "group_rerun_from_message": {
        // IX-7：无损分叉/重跑。后端落一条 system 审计标注（命令主返回值）并异步
        // 扇出 Worker 回贴；mock 同构：先推审计消息并 emit，再模拟 Worker 新回合。
        const gid = (args.group_id ?? args.groupId) as string;
        const targetSeq = args.seq as number;
        const mode = (args.mode as string) ?? "rerun";
        const workerId = (args.worker_id ?? args.workerId) as string | undefined;
        const prompt = (args.prompt as string | undefined) ?? "";
        const msgs = (messages[gid] ||= []);
        const audit: any = {
          seq: ++msgSeq,
          group_id: gid,
          author: "system",
          author_kind: "system",
          worker_id: "",
          content: `[${mode}] from #${targetSeq}${prompt ? " · " + prompt : ""}${workerId ? " @ " + workerId : ""}`,
          mentions: [],
          created_at: Date.now(),
        };
        msgs.push(audit);
        setTimeout(() => emit("roundtable-message", { type: "message", group_id: gid, message: audit }), 50);
        const turn: any = {
          seq: ++msgSeq,
          group_id: gid,
          author: workerId ?? "p_researcher",
          author_kind: "worker",
          worker_id: workerId ?? "",
          content: prompt || `（mock ${mode}）基于 #${targetSeq} 的重新作答。`,
          mentions: [],
          created_at: Date.now(),
        };
        msgs.push(turn);
        setTimeout(() => emit("roundtable-message", { type: "message", group_id: gid, message: turn }), 250);
        return audit;
      }
      case "group_roundtable_summarize": {
        const msgs = messages[(args.group_id ?? args.groupId)] ?? [];
        const s = {
          id: (summaries[(args.group_id ?? args.groupId)]?.length ?? 0) + 1,
          group_id: (args.group_id ?? args.groupId),
          content: "（mock 聚合）本次讨论形成一致结论：优先级 P0 为先做可行性验证。",
          source_seq_start: 1,
          source_seq_end: msgs.length,
          message_count: msgs.length,
          created_at: Date.now(),
        };
        (summaries[(args.group_id ?? args.groupId)] ||= []).push(s);
        setTimeout(() => emit("roundtable-summary", { type: "summary", group_id: (args.group_id ?? args.groupId), summary: s }), 200);
        return s;
      }
      case "group_list_summaries":
        return summaries[(args.group_id ?? args.groupId)] ?? [];

      // lifecycle (no-op in mock)
      case "group_pause":
      case "group_resume":
      case "group_dissolve":
        return undefined;

      // events — @tauri-apps/api/event.js routes listen()/once() through here.
      // args.handler is the integer id returned by transformCallback(handler).
      case "plugin:event|listen": {
        const ev = args.event as string;
        const handlerId = args.handler as number;
        const id = ++eventSeq;
        (eventListeners[ev] ||= []).push({ id, ev, handlerId });
        return id;
      }
      case "plugin:event|unlisten": {
        const id = args.eventId as number;
        for (const ev of Object.keys(eventListeners)) {
          eventListeners[ev] = (eventListeners[ev] || []).filter((l) => l.id !== id);
        }
        return undefined;
      }
      case "plugin:event|emit":
        return undefined;

      // window plugin (used by windowSize.ts) — return sane defaults so the
      // startup restore path doesn't throw in the browser.
      // tool permissions (P1-7) — mock returns empty overrides (default policy)
      case "list_tool_permissions":
        return [];
      case "set_tool_permission":
      case "reset_tool_permissions":
      case "clear_tool_permission":
        return undefined;

      // 日历事件（macOS 风格日程）：mock 下内存存储，返回空数组避免 for..of undefined。
      case "calendar_event_create": {
        return {
          id: "cal-" + Math.random().toString(36).slice(2, 10),
          date_key: args.payload?.date_key ?? ymd(new Date()),
          title: args.payload?.title ?? "新日程",
          content: args.payload?.content ?? "",
          time_start: args.payload?.time_start ?? null,
          time_end: args.payload?.time_end ?? null,
          color: args.payload?.color ?? "#0a84ff",
          created_at: Date.now(),
          updated_at: Date.now(),
        };
      }
      case "calendar_event_list_by_month":
        return [];
      case "calendar_event_update": {
        return { id: args.payload?.id, date_key: "", title: "", content: "",
          time_start: null, time_end: null, color: "#0a84ff", created_at: 0, updated_at: 0 };
      }
      case "calendar_event_delete":
        return undefined;
      case "reminder_notify_test":
        return undefined;
      // 灵感页自动打标：mock 下无 LLM → 返回空，前端回退本地关键词。
      case "suggest_inspiration_tags":
        return [];

      // ---- 灵感（SQLite 化后走命令层） ----
      case "list_inspirations":
        return mockInspirations.slice();
      case "create_inspiration": {
        const it = {
          id: `insp-${uid()}`,
          workspace_id: args.workspaceId ?? null,
          content: args.content ?? "",
          tags: args.tags ?? [],
          created_at: Date.now(),
        };
        mockInspirations.unshift(it);
        return it;
      }
      case "delete_inspiration": {
        const idx = mockInspirations.findIndex((x) => x.id === args.inspirationId);
        if (idx >= 0) mockInspirations.splice(idx, 1);
        return undefined;
      }

      // ---- 工作区 ----
      case "list_workspaces":
        return mockWorkspaces.slice();
      case "create_workspace": {
        const ws = {
          id: `ws-${uid()}`,
          name: args.name ?? "新工作区",
          icon: args.icon ?? null,
          created_at: Date.now(),
          updated_at: Date.now(),
          session_count: 0,
        };
        mockWorkspaces.push(ws);
        return ws;
      }
      // 关联真实目录的工作区（打开文件夹创建）。mock 仅镜像内存态，不写盘。
      case "create_workspace_with_path": {
        const ws = {
          id: `ws-${uid()}`,
          name: args.name ?? "新项目",
          icon: null,
          path: args.path ?? null,
          created_at: Date.now(),
          updated_at: Date.now(),
          session_count: 0,
        };
        mockWorkspaces.push(ws);
        return ws;
      }
      case "rename_workspace": {
        const ws = mockWorkspaces.find((x) => x.id === args.workspaceId);
        if (ws) {
          ws.name = args.name ?? ws.name;
          if (args.icon !== undefined) ws.icon = args.icon;
          ws.updated_at = Date.now();
        }
        return ws ?? null;
      }
      case "delete_workspace": {
        const idx = mockWorkspaces.findIndex((x) => x.id === args.workspaceId);
        // 默认工作区（idx 0）不可删；moveToDefault=false 时同步清掉其下灵感
        if (idx > 0) {
          if (args.moveToDefault === false) {
            for (let i = mockInspirations.length - 1; i >= 0; i--) {
              if (mockInspirations[i].workspace_id === args.workspaceId) mockInspirations.splice(i, 1);
            }
          } else {
            for (const it of mockInspirations) {
              if (it.workspace_id === args.workspaceId) it.workspace_id = null;
            }
          }
          mockWorkspaces.splice(idx, 1);
        }
        return undefined;
      }

      default:
        if (cmd.startsWith("plugin:window|")) {
          if (cmd.endsWith("outer_size") || cmd.endsWith("inner_size")) return { width: 1100, height: 750 };
          if (cmd.endsWith("is_maximized")) return false;
          return undefined;
        }
        return undefined;
    }
  };

  // NOTE: @tauri-apps/api/event.js routes listen()/once() through
  // invoke('plugin:event|listen'), handled in the invoke() switch below — no
  // separate listen() implementation is needed here.

  const internals: any = {
    invoke,
    // defensive no-ops for @tauri-apps/api internals
    convertObject: (o: any) => o,
    convertFileSrc: (p: string) => p,
    // transformCallback stores the real handler and returns an integer id,
    // exactly like the native runtime. event.js passes that id as args.handler.
    transformCallback: (cb: any, once = false) => {
      const id = ++callbackSeq;
      callbackRegistry.set(id, { cb, once });
      return id;
    },
    unregisterCallback: (id: number) => {
      callbackRegistry.delete(id);
    },
    __invoke_callback: (id: number, arg: any) => {
      const entry = callbackRegistry.get(id);
      if (!entry) return;
      entry.cb(arg);
      if (entry.once) callbackRegistry.delete(id);
    },
  };

  (window as any).__TAURI_INTERNALS__ = internals;
  (window as any).__TAURI__ = internals;
  // 测试钩子：E2E 可主动推送后端事件（如群协作 Worker 的 rt: 审批请求）。
  (window as any).__mockEmit = emit;
  // 诊断钩子（e2e 调试用）：暴露 mock 内部状态，排查会话重复/消息存储问题。
  (window as any).__mockDebug = {
    sessions: () => sessions.map((s: any) => ({ id: s.id, title: s.title })),
    messageStoreKeys: () => Object.keys(messageStore),
  };
  // event.js _unlisten() touches this object on unsubscribe; keep it a no-op so
  // component unmounts don't throw inside the browser harness.
  (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    registerListener: () => {},
    unregisterListener: () => {},
  };
}

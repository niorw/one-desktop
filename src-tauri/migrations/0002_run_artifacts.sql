-- 0002：chat 主答案关联 run_id 与本轮产物（written_files）。
--
-- 目的：让 chat 主会话的答案消息能回溯「本回合的执行实例(run_id)」与
-- 「本回合模型写出的文件(artifacts)」，从而在前端渲染
-- 「查看所有产物 (N)」「查看所有变更 (N)」两个回合级入口
-- （对齐 WorkBuddy 的 deliverables / changeset 入口）。
--
-- 数据现状（调研结论）：
--   - changeset 表已有 run_id 列，write_gate 对普通会话也生效，
--     run_changesets(run_id) 命令就绪 → 变更侧只需 run_id 关联即可查询。
--   - written_files 由 filesystem 工具收集进 AgentRunOutcome，但 chat 路径
--     send_message 丢弃 outcome → 此处落库 artifacts(JSON)。
--
-- 不变量：additive（ADR-006），仅加列、不改旧列；列可空，旧消息默认 NULL。

ALTER TABLE messages ADD COLUMN run_id TEXT;
ALTER TABLE messages ADD COLUMN artifacts TEXT;

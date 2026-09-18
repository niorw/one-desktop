-- 0005：会话事件日志（ADR-023）。
-- append-only 真相源：同一轮 Agent 运行的持久事实统一落此表；
-- messages/run_steps 降级为投影（读路径不变，双写观察期见 ADR-023 Step 1）。
-- 只记「重启后仍需存在的事实」：Token 流等瞬态事件不落库（payload 存 JSON 已留宽松度）。
-- call_id 冗余列：tool_call/tool_result 事件的 I1 配对断言走普通索引查询（不依赖 JSON1）。
CREATE TABLE IF NOT EXISTS session_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    run_id      TEXT,
    seq         INTEGER NOT NULL,
    kind        TEXT NOT NULL,
    call_id     TEXT,
    payload     TEXT NOT NULL,
    created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sevt_session_seq
    ON session_events(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_sevt_run
    ON session_events(run_id);
CREATE INDEX IF NOT EXISTS idx_sevt_session_call
    ON session_events(session_id, kind, call_id);

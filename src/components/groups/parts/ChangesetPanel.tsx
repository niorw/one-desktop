//! IX-10 变更集审阅面板：群任务结束后「本次变更集」汇总——
//! 改了哪些文件、每个文件谁改的、可一键回滚（before_content 写回）。
//!
//! 挂载点：RunsView（R5 运行视图）顶部，数据来自 F10 changeset 表
//! （`group_changesets` 群级汇总）。

import { useCallback, useEffect, useState } from "react";
// changesetRollback 是 chat 命令层的共享工具（chat 与 group 变更集面板共用），
// 群组件显式从 chatCommands 引入，避免整组命令耦合。
import { changesetRollback } from "../../../services/chatCommands";
// groupChangesets 是群级汇总命令，属于 group 命令层。
import { groupChangesets } from "../../../services/groupCommands";
import { Icons } from "../../common/Icons";
import type { ChangesetRowDto } from "../../../types";

export function ChangesetPanel({ groupId }: { groupId: string }) {
  const [rows, setRows] = useState<ChangesetRowDto[] | null>(null);
  const [rollbacking, setRollbacking] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(() => {
    groupChangesets(groupId)
      .then(setRows)
      .catch(() => setRows([]));
  }, [groupId]);

  useEffect(() => {
    load();
  }, [load]);

  if (rows === null) return null;
  if (rows.length === 0) return null;

  const handleRollback = async (id: string) => {
    if (rollbacking) return;
    setRollbacking(id);
    setMsg(null);
    try {
      const text = await changesetRollback(id);
      setMsg({ ok: true, text });
      // 回滚后该行已无意义，刷新列表。
      load();
    } catch (e) {
      setMsg({ ok: false, text: `回滚失败：${e}` });
    } finally {
      setRollbacking(null);
    }
  };

  return (
    <div className="cs-card">
      <div className="cs-head">
        <span className="cs-title">
          <Icons.Refresh size={13} />
          变更集
        </span>
        <span className="cs-count">{rows.length} 个文件改动</span>
      </div>
      {msg && (
        <div className={"cs-msg " + (msg.ok ? "ok" : "err")} role="status">
          {msg.text}
        </div>
      )}
      <div className="cs-list">
        {rows.map((r) => (
          <div key={r.id} className="cs-row">
            <span className="cs-file" title={r.file}>
              {r.file.split(/[\\/]/).pop()}
            </span>
            <span className="cs-meta">
              {r.run_id ? r.run_id.slice(0, 8) : r.holder} ·{" "}
              {r.before_content === null ? "新建" : "修改"}
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-sm cs-rollback"
              onClick={() => void handleRollback(r.id)}
              disabled={rollbacking === r.id}
              title="一键回滚到改动前内容"
            >
              {rollbacking === r.id ? "回滚中…" : "回滚"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

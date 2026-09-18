import React, { useState } from "react";
import type { RoundtableAlternative } from "../../types";
import { Markdown } from "../../utils/markdown";
import { Icons } from "../../components/common/Icons";

/**
 * R6 竞速备选并排对比（IX-9）—— insight 层第一个组件（验证组件约定：
 * 自包含数据展示 + 回调上抛，不触碰群状态、不引入全局状态）。
 *
 * FR6.1：竞速轮触发消息（owner 广播）下方「查看其他 N 个方案」，展开为并排卡片
 * （Worker 名 / 时间 / 全文），各带「改选此方案」。
 * FR6.2：改选 → `onPick(alt)` 上抛（后端落 system 消息标记，后续 Worker 种子
 * 经 find_before 自然包含该方案）。
 */
export const AltsCompare: React.FC<{
  /** 同一次竞速轮的落选方案（trigger_seq 相同） */
  alts: RoundtableAlternative[];
  /** worker_id → 显示名（由宿主 GroupsPage 注入，保持本组件零群状态依赖） */
  resolveWorkerName: (workerId: string) => string;
  /** 改选回调（宿主负责调后端 + 提示） */
  onPick: (alt: RoundtableAlternative) => void;
  /** 已改选的 alt id 集合（宿主可传以保持跨会话稳定） */
  pickedIds?: Set<number>;
}> = ({ alts, resolveWorkerName, onPick, pickedIds }) => {
  const [open, setOpen] = useState(false);
  const [justPicked, setJustPicked] = useState<Set<number>>(new Set());
  const effectivePicked = pickedIds ?? justPicked;

  const fmtTime = (ms: number) =>
    new Date(ms).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });

  return (
    <div className="alts-compare">
      <button
        type="button"
        className="alts-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="alts-toggle-label">
          {open ? "收起备选方案" : `查看其他 ${alts.length} 个方案`}
        </span>
        <span className={"alts-caret" + (open ? " open" : "")}>
          <Icons.ChevronRight size={10} />
        </span>
      </button>

      {open && (
        <div className="alts-grid">
          {alts.map((alt) => {
            const picked = effectivePicked.has(alt.id);
            return (
              <div key={alt.id} className={"alts-card" + (picked ? " picked" : "")}>
                <div className="alts-card-head">
                  <span className="alts-worker">{resolveWorkerName(alt.worker_id)}</span>
                  <span className="alts-time">{fmtTime(alt.created_at)}</span>
                </div>
                <div className="alts-body">
                  <Markdown>{alt.content}</Markdown>
                </div>
                <div className="alts-card-foot">
                  <button
                    type="button"
                    className={"alts-pick-btn" + (picked ? " picked" : "")}
                    disabled={picked}
                    onClick={() => {
                      onPick(alt);
                      setJustPicked((prev) => new Set(prev).add(alt.id));
                    }}
                  >
                    {picked ? (
                      <>
                        <Icons.Check size={12} /> 已改选
                      </>
                    ) : (
                      "改选此方案"
                    )}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

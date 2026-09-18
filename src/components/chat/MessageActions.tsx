// ══════════════════════════════════════════════
//  MessageActions — 答案/总结尾部的操作栏
//  ┌──────────────────────────────────────────────────────────┐
//  │  复制    重新生成（仅末尾回合）    👍    👎                │
//  └──────────────────────────────────────────────────────────┘
//
//  接管两处出口，保证 chat 主答案与 done 态终答的操作栏绝对一致：
//  1. `MessageList::AnswerBubble`（无工具轮 / 纯文本回合）
//  2. `ProcessPanel::.pp-answer-zone`（工具轮 done 状态的终答）
//
//  设计纪律：
//  - 复用既有 `.action-bar` / `.action-btn` / `.feedback-btn` / `.copy-toast`
//    样式，**不**引入新 CSS 变量、不重复造类。
//  - 反馈与复制状态都是纯本地 `useState`（与 AnswerBubble 现状一致），
//    无后端入库、无 zustand / 自定义 store。后续若要接持久化埋点，
//    替换 `setFeedback` / 复制 onClick 即可，**不要**平移两处 JSX。
//  - `.action-bar` 自身已是 `position: relative`（见 App.css），因此
//    `.copy-toast` 绝对定位不需要依赖任何外层 `position` 上下文。
// ══════════════════════════════════════════════

import { useState } from "react";
import { Icons } from "../common/Icons";
import { useI18n } from "../../i18n/I18nProvider";

export interface MessageActionsProps {
  /** 复制源（与界面渲染一致：天气表/半残表请传 cleanText，保证所见即所得）。 */
  text: string;
  /** 重新生成回调；不传则不渲染「重新生成」按钮。 */
  onRegenerate?: () => void;
  /** 是否在最后一回合（决定是否显示「重新生成」按钮）。 */
  showRegenerate?: boolean;
  /** 给整个 action-bar 加额外 className（用于特殊父级下微调）。 */
  className?: string;
}

export function MessageActions({
  text,
  onRegenerate,
  showRegenerate,
  className,
}: MessageActionsProps) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState<"up" | "down" | null>(null);

  const handleCopy = () => {
    // 不论剪贴板 API 是否在沙箱/不可用环境可用，都尝试；失败静默（与现状一致）。
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className={"action-bar" + (className ? " " + className : "")}>
      <button type="button" className="action-btn" title={t("common.copy")} aria-label={t("common.copy")} onClick={handleCopy}>
        <Icons.Copy />
      </button>
      {showRegenerate && onRegenerate && (
        <button type="button" className="action-btn" title={t("common.regenerate")} aria-label={t("common.regenerate")} onClick={onRegenerate}>
          <Icons.Refresh />
        </button>
      )}
      <button
        type="button"
        className={`action-btn feedback-btn ${feedback === "up" ? "active" : ""}`}
        title={t("common.thumbsUp")}
        aria-label={t("common.thumbsUp")}
        aria-pressed={feedback === "up"}
        onClick={() => setFeedback((p) => (p === "up" ? null : "up"))}
      >
        <Icons.ThumbUp />
      </button>
      <button
        type="button"
        className={`action-btn feedback-btn ${feedback === "down" ? "active" : ""}`}
        title={t("common.thumbsDown")}
        aria-label={t("common.thumbsDown")}
        aria-pressed={feedback === "down"}
        onClick={() => setFeedback((p) => (p === "down" ? null : "down"))}
      >
        <Icons.ThumbDown />
      </button>
      {copied && <span className="copy-toast" role="status">{t("common.copied")}</span>}
    </div>
  );
}

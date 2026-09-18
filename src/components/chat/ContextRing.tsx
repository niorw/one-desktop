import type { ContextStats, } from "./contextStats";
import { formatTokens } from "./contextStats";
import { useI18n } from "../../i18n/I18nProvider";

/** 用量阈值（百分比）：低于 RING_LOW 绿色，RING_LOW~RING_HIGH 黄色，达到 RING_HIGH 红色。 */
const RING_LOW = 50;
const RING_HIGH = 80;

/** 环几何：直径 22（比 model-trigger 24px 略小，融入工具栏），stroke 2.5 保持浅色可见。 */
const RING_SIZE = 22;
const RING_CENTER = RING_SIZE / 2;
const RING_R = 9.5;
const RING_STROKE = 2.5;
const RING_CIRC = 2 * Math.PI * RING_R;

/** 用量等级：empty（无数据/零用量，灰） | low（绿） | mid（黄） | high（红）。 */
export type RingLevel = "empty" | "low" | "mid" | "high";

interface ContextRingProps {
  /** 上下文统计；缺省、无效或全零时渲染灰色空态。 */
  stats?: ContextStats | null;
}

/**
 * 上下文用量环形指示器（挂在 model-trigger 左侧）。
 * - 外部 SVG 环形 = 占用比例，按使用率自动变色；
 * - 内部 = 占用百分比；
 * - 悬浮 = 统计明细 tooltip（已用/剩余/上限/轮次）。
 * 纯展示组件：不含任何点击交互，不影响 model-trigger 原有行为。
 */
export function ContextRing({ stats }: ContextRingProps) {
  const { t } = useI18n();
  // 有效性：需有统计且已用 > 0、窗口上限 > 0，否则走空态
  const valid = !!stats && stats.usedTokens > 0 && stats.contextWindow > 0;
  const pct = valid ? Math.min(stats.usedTokens / stats.contextWindow, 1) : 0;
  const pctDisplay = Math.round(pct * 100);

  const level: RingLevel = !valid
    ? "empty"
    : pct < RING_LOW / 100
      ? "low"
      : pct < RING_HIGH / 100
        ? "mid"
        : "high";

  const dash = pct * RING_CIRC;

  // a11y：对读屏输出完整摘要
  const ariaLabel = valid
    ? t("context.usageAria", {
        p: pctDisplay,
        used: formatTokens(stats.usedTokens),
        total: formatTokens(stats.contextWindow),
        rem: formatTokens(Math.max(stats.contextWindow - stats.usedTokens, 0)),
        turns: stats.turns,
      })
    : t("context.emptyAria");

  return (
    <div
      className={`context-ring ring-${level}`}
      role="img"
      aria-label={ariaLabel}
      title={valid ? t("context.tooltip", { percent: pctDisplay, used: formatTokens(stats.usedTokens), total: formatTokens(stats.contextWindow) }) : t("context.title")}
    >
      <svg width={RING_SIZE} height={RING_SIZE} viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`} aria-hidden="true">
        {/* 底环：浅灰描边 */}
        <circle
          className="context-ring-track"
          cx={RING_CENTER}
          cy={RING_CENTER}
          r={RING_R}
          fill="none"
          strokeWidth={RING_STROKE}
        />
        {/* 进度环：dasharray 表达占用比例，-90° 从顶部起画 */}
        <circle
          className="context-ring-value"
          cx={RING_CENTER}
          cy={RING_CENTER}
          r={RING_R}
          fill="none"
          strokeWidth={RING_STROKE}
          strokeDasharray={`${dash} ${RING_CIRC - dash}`}
          strokeLinecap="round"
          transform={`rotate(-90 ${RING_CENTER} ${RING_CENTER})`}
        />
      </svg>

      {/* 环内核心指标：占比数字（不带百分号）；空态显示 — */}
      <span className="context-ring-label">{valid && pctDisplay > 0 ? `${pctDisplay}` : "—"}</span>

      {/* 悬浮明细 tooltip */}
      <div className="context-ring-tip" role="tooltip">
        {valid ? (
          <>
            <div className="context-ring-tip-title">{t("context.title")}</div>
            <div className="context-ring-tip-row">
              <span>{t("context.usedTokens")}</span>
              <b>{formatTokens(stats.usedTokens)}</b>
            </div>
            <div className="context-ring-tip-row">
              <span>{t("context.usedPercent")}</span>
              <b>{pctDisplay}%</b>
            </div>
            <div className="context-ring-tip-row">
              <span>{t("context.remaining")}</span>
              <b>{formatTokens(Math.max(stats.contextWindow - stats.usedTokens, 0))}</b>
            </div>
            <div className="context-ring-tip-row">
              <span>{t("context.windowLimit")}</span>
              <b>{formatTokens(stats.contextWindow)}</b>
            </div>
            <div className="context-ring-tip-row">
              <span>{t("context.turns")}</span>
              <b>{stats.turns}</b>
            </div>
          </>
        ) : (
          <div className="context-ring-tip-empty">{t("context.noData")}</div>
        )}
      </div>
    </div>
  );
}

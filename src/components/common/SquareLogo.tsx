import type { CSSProperties } from "react";
import squarePng from "../../assets/one-desktop-square.png";

/** OneDesktop 方形 logo（蓝白渐变 ∞，1024×1024 主图）。
 * 用于启动屏、对话头像等"接近正方形"场景——比 3:2 横向版本更协调。
 *
 * **尺寸完全由 className 对应的 CSS 控制**（与 InfinityLogo 同契约）。
 * 不传 width 默认值（保留 prop 是为了 API 兼容/特殊 override）——曾踩坑：
 * inline style 优先级覆盖 CSS 导致「CSS 改了 size 不变」。 */
export function SquareLogo({
  width, // 保留 prop 以保持 API 兼容，但不默认应用
  className,
  ariaLabel = "OneDesktop logo",
  style,
}: {
  width?: number;
  className?: string;
  ariaLabel?: string;
  style?: CSSProperties;
}) {
  return (
    <img
      className={className}
      src={squarePng}
      alt={ariaLabel}
      // 显式传 style.width 才覆盖；不传则完全交给 CSS className
      style={{
        display: "block",
        ...(width !== undefined ? { width } : {}),
        ...style,
      }}
    />
  );
}

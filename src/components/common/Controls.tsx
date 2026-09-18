// Controls — 通用控件基座。只引用 App.css 全局语义类，组件内不写样式；按钮显式 type="button"。
import type { ReactNode } from "react";

/**
 * 单选分段控件。`icon` 与 `ariaLabelledBy` 均为可选，老调用点无需改动。
 * 用在「标签在左、控件在右」的行里时传 `ariaLabelledBy`，让读屏能把行标签
 * 念给这组按钮 —— 视觉上的 label 对 button 不构成语义关联。
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabelledBy,
}: {
  options: { value: T; label: string; icon?: ReactNode }[];
  value: T;
  onChange: (value: T) => void;
  ariaLabelledBy?: string;
}) {
  return (
    <div
      className="segmented-control"
      role={ariaLabelledBy ? "group" : undefined}
      aria-labelledby={ariaLabelledBy}
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={value === opt.value ? "active" : ""}
          aria-pressed={value === opt.value}
          onClick={() => onChange(opt.value)}
        >
          {opt.icon && <span className="segmented-icon">{opt.icon}</span>}
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/** 开关（label 包裹原生 checkbox，描述可选）。 */
export function Toggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
}) {
  return (
    <label className="settings-toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track">
        <span className="toggle-thumb" />
      </span>
      <span className="toggle-text">
        <span className="toggle-label">{label}</span>
        {description && <span className="toggle-desc">{description}</span>}
      </span>
    </label>
  );
}

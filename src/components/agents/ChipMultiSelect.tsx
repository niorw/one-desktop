import { useState } from "react";
import { Icons } from "../common/Icons";
import "./ChipMultiSelect.css";

/** 可视化多选 chip 组件（替代原生 TagInput）。
 *  - 候选列表（candidates）渲染为可点选 chip
 *  - 用户自由输入的额外值也会保留在 selected 集合里（向后兼容旧数据）
 *  - 选中态用 accent-soft + 内嵌对勾，圆角色
 *  - 每行末尾的「+ 自定义」输入：按 Enter / 逗号 / 空格提交，写入 selected 并清空输入
 */
export function ChipMultiSelect({
  candidates,
  selected,
  onChange,
  placeholder = "回车 / 逗号 / 空格 添加",
}: {
  candidates: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState("");

  // 合并（candidates + 用户自由值）作为 chip 渲染集合，去重保序
  const all = (() => {
    const set = new Set(candidates);
    for (const s of selected) set.add(s);
    return Array.from(set);
  })();

  const isSelected = (v: string) => selected.includes(v);
  const toggle = (v: string) => {
    onChange(
      isSelected(v)
        ? selected.filter((x) => x !== v)
        : [...selected, v],
    );
  };

  const commitDraft = () => {
    const tokens = draft
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (tokens.length === 0) return;
    const set = new Set(selected);
    let changed = false;
    for (const t of tokens) {
      if (!set.has(t)) {
        set.add(t);
        changed = true;
      }
    }
    if (changed) onChange(Array.from(set));
    setDraft("");
  };

  return (
    <div className="cms-root">
      <div className="cms-chips" role="listbox" aria-multiselectable>
        {all.map((v) => {
          const selected = isSelected(v);
          return (
            <button
              key={v}
              type="button"
              role="option"
              aria-selected={selected}
              className={`cms-chip ${selected ? "active" : ""}`}
              onClick={() => toggle(v)}
            >
              {selected && (
                <span className="cms-chip-check" aria-hidden="true">
                  <Icons.Check size={8} />
                </span>
              )}
              <span>{v}</span>
            </button>
          );
        })}
      </div>
      <div className="cms-input-row">
        <Icons.Plus size={12} />
        <input
          className="cms-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "," || e.key === " ") {
              e.preventDefault();
              commitDraft();
            }
          }}
          onBlur={commitDraft}
          placeholder={placeholder}
        />
      </div>
    </div>
  );
}

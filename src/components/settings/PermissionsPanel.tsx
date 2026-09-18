import { useEffect, useState } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import type { DictKey } from "../../i18n/dict";
import * as tauri from "../../services/tauri";
import type { PermissionAction } from "../../types";

/** 已知工具（默认矩阵覆盖面）；新增工具在默认策略下 fail-closed，无需改动此处。 */
const KNOWN_TOOLS = ["run_shell", "read_file", "write_file", "list_dir", "update_memory"];
const SCOPES = ["user", "worker"] as const;

const toolLabelKey = (tool: string): DictKey =>
  `settings.permissions.tool.${tool}` as DictKey;
const scopeLabelKey = (scope: string): DictKey =>
  `settings.permissions.scope.${scope}` as DictKey;
const actionLabelKey = (a: PermissionAction | ""): DictKey =>
  `settings.permissions.action.${a === "" ? "default" : a}` as DictKey;

export function PermissionsPanel() {
  const { t } = useI18n();
  /** `${tool}:${scope}` → 显式覆盖；"" 表示继承默认矩阵。 */
  const [overrides, setOverrides] = useState<Record<string, PermissionAction | "">>({});
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const rows = (await tauri.listToolPermissions()) ?? [];
      const map: Record<string, PermissionAction | ""> = {};
      for (const r of rows) map[`${r.tool_name}:${r.scope}`] = r.action;
      setOverrides(map);
    } catch {
      // 命令不可用（如 E2E mock / 旧后端）：保持默认策略展示。
      setOverrides({});
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const onChange = async (tool: string, scope: string, value: PermissionAction | "") => {
    setBusy(true);
    try {
      if (value === "") {
        await tauri.clearToolPermission(tool, scope);
      } else {
        await tauri.setToolPermission(tool, scope, value);
      }
      setOverrides((prev) => ({ ...prev, [`${tool}:${scope}`]: value }));
    } finally {
      setBusy(false);
    }
  };

  const onReset = async () => {
    setBusy(true);
    try {
      await tauri.resetToolPermissions();
      setOverrides({});
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-card">
      <div className="settings-card-head">
        <span>{t("settings.permissions.title")}</span>
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={onReset}>
          {t("settings.permissions.reset")}
        </button>
      </div>
      <p className="settings-hint">{t("settings.permissions.hint")}</p>
      <div className="perm-table">
        <div className="perm-row perm-head">
          <span className="perm-cell-tool">{t("settings.permissions.col.tool")}</span>
          {SCOPES.map((s) => (
            <span key={s} className="perm-cell">
              {t(scopeLabelKey(s))}
            </span>
          ))}
        </div>
        {KNOWN_TOOLS.map((tool) => (
          <div key={tool} className="perm-row">
            <span className="perm-cell-tool">{t(toolLabelKey(tool))}</span>
            {SCOPES.map((scope) => {
              const key = `${tool}:${scope}`;
              const value = overrides[key] ?? "";
              return (
                <select
                  key={scope}
                  className={`perm-select perm-${value || "default"}`}
                  value={value}
                  disabled={busy}
                  onChange={(e) =>
                    onChange(tool, scope, e.target.value as PermissionAction | "")
                  }
                >
                  {(["", "allow", "deny", "ask"] as const).map((a) => (
                    <option key={a} value={a}>
                      {t(actionLabelKey(a))}
                    </option>
                  ))}
                </select>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

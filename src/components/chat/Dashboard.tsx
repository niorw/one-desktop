import { useState, useRef, forwardRef, useImperativeHandle } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import { Icons } from "../common/Icons";
import type { PermissionMode, ModelProviderConfig } from "../../types";
import type { Workspace } from "../../services/workspace";
import type { QueuedMessage } from "../../hooks/useAgent";
import { InputBar, type InputBarHandle } from "./InputBar";
import { SquareLogo } from "../common/SquareLogo";

export interface DashboardHandle {
  /** 聚焦到 Dashboard 内的输入框。 */
  focus: () => void;
}

interface DashboardProps {
  onSendMessage: (content: string) => void;
  isStreaming?: boolean;
  model?: string;
  onModelChange?: (model: string) => void;
  permissionMode?: PermissionMode;
  onPermissionChange?: (mode: PermissionMode) => void;
  onStop?: () => void;
  onUpgrade?: () => void;
  workspaces?: Workspace[];
  activeWorkspaceId?: string;
  onSwitchWorkspace?: (id: string) => void;
  /** 打开文件夹 → 关联/创建工作区。 */
  onOpenFolder?: () => void;
  queuedItems?: QueuedMessage[];
  onRemoveQueued?: (index: number) => void;
  onEditQueued?: (index: number, newText: string) => void;
  onMoveUpQueued?: (index: number) => void;
  /** 打开模型设置。 */
  onOpenModelSettings?: () => void;
  /** 已配置的供应商列表（驱动输入框模型选择器）。 */
  providers?: ModelProviderConfig[];
}

export const Dashboard = forwardRef<DashboardHandle, DashboardProps>(function Dashboard({
  onSendMessage,
  isStreaming, model, onModelChange, permissionMode, onPermissionChange, onStop, onUpgrade,
  workspaces, activeWorkspaceId, onSwitchWorkspace, onOpenFolder,
  queuedItems = [], onRemoveQueued, onEditQueued, onMoveUpQueued,
  onOpenModelSettings, providers = [],
}, ref) {
  const { t } = useI18n();
  const inputRef = useRef<InputBarHandle>(null);
  useImperativeHandle(ref, () => ({
    focus: () => inputRef.current?.focus(),
  }), []);

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <div className="dashboard-header-main">
          <div className="dashboard-hero">
              {/* 双行品牌锁：方形 logo + OneDesktop/All Solutions 竖排，品牌强曝光 */}
              <div className="dashboard-brand-lock">
                <SquareLogo className="dashboard-brand-logo" />
              <div className="dashboard-brand-words">
                <span className="dashboard-brand-w1">OneDesktop</span>
                <span className="dashboard-brand-w2">All Solutions</span>
              </div>
            </div>
            <div className="dashboard-brand-divider" aria-hidden="true" />
            <h1 className="dashboard-greeting">{t("dashboard.greeting")}</h1>
          </div>
        </div>
      </header>

      <InputBar
        ref={inputRef}
        onSend={onSendMessage}
        isStreaming={isStreaming}
        model={model}
        onModelChange={onModelChange}
        permissionMode={permissionMode}
        onPermissionChange={onPermissionChange}
        onStop={onStop}
        onUpgrade={onUpgrade}
        queuedItems={queuedItems}
        onRemoveQueued={onRemoveQueued}
        onEditQueued={onEditQueued}
        onMoveUpQueued={onMoveUpQueued}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        onWorkspaceChange={onSwitchWorkspace}
        onOpenFolder={onOpenFolder}
        onOpenModelSettings={onOpenModelSettings}
        providers={providers}
      />
    </div>
  );
});

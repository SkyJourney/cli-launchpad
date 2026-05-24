import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Copy, Download, RefreshCw, Upload } from "lucide-react";
import clsx from "clsx";
import { useState } from "react";
import { indexByTool, useCliStatus } from "../hooks/useCliStatus";
import { copyText } from "../lib/clipboard";
import { hasUpdate } from "../lib/format";
import { TOOLS } from "../lib/tools";
import {
  exportConfig,
  fetchLatestVersions,
  getInstallPlan,
  importConfig,
  runInstall,
  type CliAvailability,
  type InstallKind,
  type InstallOutcome,
  type InstallPlan,
  type ToolKey,
} from "../lib/tauri";
import { useAppStore } from "../store/appStore";

const STATUS_LABEL: Record<CliAvailability, string> = {
  available: "已安装 · PATH 可见",
  path_not_visible: "已安装 · PATH 不可见",
  missing: "未检测到",
};

const STATUS_CLASS: Record<CliAvailability, string> = {
  available: "badge-available",
  path_not_visible: "badge-warn",
  missing: "badge-missing",
};

interface PendingAction {
  toolKey: ToolKey;
  kind: InstallKind;
  plan: InstallPlan;
}

export function SettingsView() {
  const setView = useAppStore((state) => state.setView);
  const queryClient = useQueryClient();
  const cliStatus = useCliStatus();
  const statusByTool = indexByTool(cliStatus.data);

  const latest = useQuery({
    queryKey: ["latest-versions"],
    queryFn: fetchLatestVersions,
    staleTime: 1000 * 60 * 30,
  });
  const latestByTool = new Map(
    latest.data?.map((entry) => [entry.toolKey, entry.latest]),
  );

  const [pending, setPending] = useState<PendingAction | null>(null);
  const [outcome, setOutcome] = useState<InstallOutcome | null>(null);

  const [exportText, setExportText] = useState("");
  const [importText, setImportText] = useState("");

  const exportMutation = useMutation({
    mutationFn: exportConfig,
    onSuccess: (json) => setExportText(json),
  });

  const importMutation = useMutation({
    mutationFn: (json: string) => importConfig(json),
    onSuccess: () => {
      setImportText("");
      queryClient.invalidateQueries({ queryKey: ["directories"] });
      queryClient.invalidateQueries({ queryKey: ["tools"] });
      queryClient.invalidateQueries({ queryKey: ["directory-tool-args"] });
    },
  });

  const startAction = async (toolKey: ToolKey, kind: InstallKind) => {
    setOutcome(null);
    const plan = await getInstallPlan(toolKey, kind);
    setPending({ toolKey, kind, plan });
  };

  const runMutation = useMutation({
    mutationFn: (action: PendingAction) =>
      runInstall(action.toolKey, action.kind),
    onSuccess: (result) => {
      setOutcome(result);
      setPending(null);
      // Re-detect status and latest versions after install/update.
      queryClient.invalidateQueries({ queryKey: ["cli-status"] });
      queryClient.invalidateQueries({ queryKey: ["latest-versions"] });
    },
  });

  return (
    <div className="settings-view">
      <button className="ghost-button" onClick={() => setView("projects")}>
        <ArrowLeft size={15} />
        返回
      </button>

      <header className="detail-head settings-head">
        <h1>设置</h1>
        <button
          className="icon-button"
          title="重新检测"
          onClick={() => {
            void cliStatus.refetch();
            void latest.refetch();
          }}
          disabled={cliStatus.isFetching}
        >
          <RefreshCw
            size={15}
            className={clsx({ spinning: cliStatus.isFetching })}
          />
        </button>
      </header>

      <section className="cli-status-list">
        <div className="section-heading">CLI 状态</div>
        {TOOLS.map((tool) => {
          const status = statusByTool[tool.key];
          const availability = status?.status ?? "missing";
          const latestVersion = latestByTool.get(tool.key) ?? null;
          const updatable = hasUpdate(status?.version ?? null, latestVersion);
          const isMissing = availability === "missing";

          return (
            <div className="cli-status-row" key={tool.key}>
              <div className="cli-status-name">
                <tool.icon size={18} />
                <strong>{tool.label}</strong>
                <span className={clsx("cli-badge", STATUS_CLASS[availability])}>
                  {STATUS_LABEL[availability]}
                </span>
                {updatable === true && (
                  <span className="update-flag">有更新</span>
                )}
              </div>

              <div className="cli-status-detail muted">
                {status?.path && <span>路径：{status.path}</span>}
                <span>
                  当前：{status?.version ?? (isMissing ? "—" : "未知")}
                </span>
                <span>
                  最新：
                  {latest.isFetching
                    ? "查询中…"
                    : (latestVersion ?? "无法获取")}
                </span>
              </div>

              <div className="cli-status-actions">
                {isMissing ? (
                  <button
                    className="primary-button"
                    onClick={() => void startAction(tool.key, "install")}
                  >
                    <Download size={15} />
                    一键安装
                  </button>
                ) : (
                  updatable === true && (
                    <button
                      className="primary-button"
                      onClick={() => void startAction(tool.key, "update")}
                    >
                      <Download size={15} />
                      更新
                    </button>
                  )
                )}
              </div>
            </div>
          );
        })}
      </section>

      <section className="config-backup">
        <div className="section-heading">配置备份</div>
        <div className="config-actions">
          <button
            className="ghost-button"
            onClick={() => exportMutation.mutate()}
            disabled={exportMutation.isPending}
          >
            <Download size={15} />
            导出配置
          </button>
          {exportText && (
            <button
              className="ghost-button"
              onClick={() => void copyText(exportText)}
            >
              <Copy size={14} />
              复制
            </button>
          )}
        </div>
        {exportText && (
          <textarea className="config-text" readOnly value={exportText} />
        )}

        <p className="muted">
          粘贴配置 JSON 后导入（按路径合并，不会重复添加目录）：
        </p>
        <textarea
          className="config-text"
          placeholder="在此粘贴导出的配置 JSON"
          value={importText}
          onChange={(event) => setImportText(event.target.value)}
        />
        <div className="config-actions">
          <button
            className="primary-button"
            disabled={!importText.trim() || importMutation.isPending}
            onClick={() => importMutation.mutate(importText)}
          >
            <Upload size={15} />
            导入配置
          </button>
        </div>
        {importMutation.isError && (
          <p className="error">导入失败：{String(importMutation.error)}</p>
        )}
        {importMutation.isSuccess && <p className="muted">导入成功。</p>}
      </section>

      {pending && (
        <section className="confirm-panel">
          <div className="section-heading">
            {pending.kind === "install" ? "确认安装" : "确认更新"}
          </div>
          <p className="muted">来源：{pending.plan.source}</p>
          <code className="readonly-args">{pending.plan.preview}</code>
          <p className="muted">
            该命令将在你的机器上执行，确认后开始并输出日志。
          </p>
          <div className="edit-actions">
            <button
              className="ghost-button"
              onClick={() => setPending(null)}
              disabled={runMutation.isPending}
            >
              取消
            </button>
            <button
              className="primary-button"
              onClick={() => runMutation.mutate(pending)}
              disabled={runMutation.isPending}
            >
              {runMutation.isPending ? "执行中…" : "确认执行"}
            </button>
          </div>
        </section>
      )}

      {outcome && (
        <section className="install-log">
          <div className="section-heading">
            执行结果 · {outcome.success ? "成功" : "失败"}
          </div>
          <code className={clsx("log-output", { failed: !outcome.success })}>
            {outcome.log || "（无输出）"}
          </code>
        </section>
      )}
    </div>
  );
}

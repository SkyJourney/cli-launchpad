import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Download, RefreshCw } from "lucide-react";
import clsx from "clsx";
import { useState } from "react";
import { indexByTool, useCliStatus } from "../hooks/useCliStatus";
import { hasUpdate } from "../lib/format";
import { TOOLS } from "../lib/tools";
import {
  fetchLatestVersions,
  getInstallPlan,
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

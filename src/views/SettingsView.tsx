import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Download, RefreshCw, Save, Upload } from "lucide-react";
import clsx from "clsx";
import { useState } from "react";
import { useTools } from "../hooks/queries";
import {
  CLI_STATUS_META,
  indexByTool,
  useCliStatus,
} from "../hooks/useCliStatus";
import { useSeededState } from "../hooks/useSeededState";
import { hasUpdate } from "../lib/format";
import { qk } from "../lib/queryKeys";
import { emptyToolMap, TOOLS } from "../lib/tools";
import {
  exportConfigToPath,
  fetchLatestVersions,
  getInstallPlan,
  getShellProfiles,
  importConfigFromPath,
  listTools,
  runInstall,
  saveToolGlobalArgs,
  setShellKind,
  type InstallKind,
  type InstallOutcome,
  type InstallPlan,
  type ShellKind,
  type Tool,
  type ToolKey,
} from "../lib/tauri";

const SHELL_OPTIONS: { kind: ShellKind; label: string }[] = [
  { kind: "wt-pwsh", label: "Windows Terminal + PowerShell" },
  { kind: "pwsh", label: "PowerShell 窗口" },
  { kind: "cmd", label: "CMD 窗口" },
];

type GlobalArgsMap = Record<ToolKey, string>;

function toolsToGlobalArgs(tools: Tool[]): GlobalArgsMap {
  const next = emptyToolMap();
  for (const tool of tools) {
    next[tool.key] = tool.globalArgs;
  }
  return next;
}

interface PendingAction {
  toolKey: ToolKey;
  kind: InstallKind;
  plan: InstallPlan;
}

export function SettingsView() {
  const queryClient = useQueryClient();
  const cliStatus = useCliStatus();
  const statusByTool = indexByTool(cliStatus.data);

  const latest = useQuery({
    queryKey: qk.latestVersions(),
    queryFn: fetchLatestVersions,
    staleTime: 1000 * 60 * 30,
  });
  const latestByTool = new Map(
    latest.data?.map((entry) => [entry.toolKey, entry.latest]),
  );

  const shellProfiles = useQuery({
    queryKey: qk.shellProfiles(),
    queryFn: getShellProfiles,
  });
  const currentShellKind: ShellKind =
    shellProfiles.data?.[0]?.kind ?? "wt-pwsh";
  const shellKindMutation = useMutation({
    mutationFn: (kind: ShellKind) => setShellKind(kind),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: qk.shellProfiles() }),
  });

  // Global tool args (apply to every project; project-level args override them).
  const tools = useTools();
  const [globalArgs, setGlobalArgs] = useSeededState<Tool[], GlobalArgsMap>(
    tools.data,
    toolsToGlobalArgs,
    emptyToolMap(),
    "global",
  );

  const saveGlobalArgsMutation = useMutation({
    mutationFn: async () => {
      await Promise.all(
        TOOLS.map((tool) =>
          saveToolGlobalArgs(tool.key, globalArgs[tool.key].trim()),
        ),
      );
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.tools() }),
  });

  const [pending, setPending] = useState<PendingAction | null>(null);
  const [outcome, setOutcome] = useState<InstallOutcome | null>(null);

  const exportMutation = useMutation({
    mutationFn: async () => {
      const path = await save({
        defaultPath: "cli-launchpad-config.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) {
        return false;
      }
      await exportConfigToPath(path);
      return true;
    },
  });

  const importMutation = useMutation({
    mutationFn: async () => {
      const selected = await open({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (typeof selected !== "string") {
        return false;
      }
      await importConfigFromPath(selected);
      return true;
    },
    onSuccess: async (didImport) => {
      if (!didImport) {
        return;
      }
      queryClient.invalidateQueries({ queryKey: qk.directories() });
      queryClient.invalidateQueries({ queryKey: qk.directoryToolArgs() });
      // Re-seed the global-args editor from the freshly imported tools (await
      // the fetch so we don't seed from stale data).
      const fresh = await queryClient.fetchQuery({
        queryKey: qk.tools(),
        queryFn: listTools,
      });
      setGlobalArgs(toolsToGlobalArgs(fresh));
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
      queryClient.invalidateQueries({ queryKey: qk.cliStatus() });
      queryClient.invalidateQueries({ queryKey: qk.latestVersions() });
    },
  });

  return (
    <div className="settings-view">
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
        {cliStatus.isError && (
          <p className="error">检测失败：{String(cliStatus.error)}</p>
        )}
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
                <span
                  className={clsx(
                    "cli-badge",
                    CLI_STATUS_META[availability].badgeClass,
                  )}
                >
                  {CLI_STATUS_META[availability].label}
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

      <section className="shell-config">
        <div className="section-heading">启动方式</div>
        <p className="muted">选择在哪个终端 / Shell 中打开 CLI：</p>
        <div className="model-presets">
          {SHELL_OPTIONS.map((option) => (
            <button
              key={option.kind}
              className={clsx("preset-button", {
                active: currentShellKind === option.kind,
              })}
              disabled={shellKindMutation.isPending}
              onClick={() => shellKindMutation.mutate(option.kind)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </section>

      <section className="shell-config">
        <div className="section-heading">工具全局参数</div>
        <p className="muted">对所有项目生效；项目级参数会覆盖同名参数。</p>
        {TOOLS.map((tool) => (
          <div className="global-arg-row" key={tool.key}>
            <label className="global-arg-label">
              <tool.icon size={16} />
              {tool.label}
            </label>
            <input
              value={globalArgs[tool.key]}
              placeholder="例如 --dangerously-skip-permissions"
              onChange={(event) =>
                setGlobalArgs((prev) => ({
                  ...prev,
                  [tool.key]: event.target.value,
                }))
              }
            />
          </div>
        ))}
        <div className="config-actions">
          <button
            className="primary-button"
            disabled={saveGlobalArgsMutation.isPending}
            onClick={() => saveGlobalArgsMutation.mutate()}
          >
            <Save size={15} />
            保存全局参数
          </button>
          {saveGlobalArgsMutation.isSuccess && (
            <span className="muted">已保存。</span>
          )}
        </div>
      </section>

      <section className="config-backup">
        <div className="section-heading">配置备份</div>
        <p className="muted">
          导出/导入目录、工具参数到文件（导入按路径合并，不重复添加目录）。
        </p>
        <div className="config-actions">
          <button
            className="ghost-button"
            onClick={() => exportMutation.mutate()}
            disabled={exportMutation.isPending}
          >
            <Download size={15} />
            导出到文件
          </button>
          <button
            className="ghost-button"
            onClick={() => importMutation.mutate()}
            disabled={importMutation.isPending}
          >
            <Upload size={15} />
            从文件导入
          </button>
        </div>
        {exportMutation.isSuccess && exportMutation.data && (
          <p className="muted">已导出。</p>
        )}
        {exportMutation.isError && (
          <p className="error">导出失败：{String(exportMutation.error)}</p>
        )}
        {importMutation.isSuccess && importMutation.data && (
          <p className="muted">导入成功。</p>
        )}
        {importMutation.isError && (
          <p className="error">导入失败：{String(importMutation.error)}</p>
        )}
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

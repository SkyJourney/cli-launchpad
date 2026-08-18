import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Download, RefreshCw, Save, Upload } from "lucide-react";
import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import { useTools } from "../hooks/queries";
import {
  CLI_STATUS_META,
  indexByTool,
  useCliStatus,
} from "../hooks/useCliStatus";
import { useSeededState } from "../hooks/useSeededState";
import {
  isExecutionActive,
  upsertExecutionTask,
  useExecutionTasks,
} from "../hooks/useExecutionTasks";
import { formatUtcDateTime, hasUpdate } from "../lib/format";
import { qk } from "../lib/queryKeys";
import { emptyToolMap, TOOLS } from "../lib/tools";
import {
  clearCache,
  clearLaunchHistory,
  createBackup,
  detectCliStatus,
  detectTerminalEnvironment,
  exportConfigToPath,
  exportDiagnosticsToPath,
  fetchLatestVersions,
  getCacheStats,
  getCloseBehavior,
  getInstallPlan,
  getLaunchTarget,
  importConfigFromPath,
  listBackups,
  listLaunchHistory,
  listTools,
  startExecutionTask,
  restoreBackup,
  saveToolGlobalArgsBatch,
  setCloseBehavior,
  setLaunchTarget,
  type InstallKind,
  type InstallPlan,
  type ExecutionTask,
  type BackupManifest,
  type CloseBehavior,
  type ProfilePreservation,
  type ShellFamily,
  type Tool,
  type ToolKey,
} from "../lib/tauri";
import { useAppStore } from "../store/appStore";

const CLOSE_BEHAVIOR_OPTIONS: { value: CloseBehavior; label: string }[] = [
  { value: "minimize_to_tray", label: "关闭后保持后台运行" },
  { value: "quit", label: "退出应用" },
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

interface ActionError {
  toolKey: ToolKey;
  message: string;
}

export function SettingsView() {
  const queryClient = useQueryClient();
  const setView = useAppStore((state) => state.setView);
  const cliStatus = useCliStatus();
  const executionTasks = useExecutionTasks();
  const activeTask = executionTasks.data?.find((task) =>
    isExecutionActive(task.status),
  );
  const statusByTool = indexByTool(cliStatus.data);

  const latest = useQuery({
    queryKey: qk.latestVersions(),
    queryFn: () => fetchLatestVersions(false),
    staleTime: 1000 * 60 * 30,
  });
  const latestByTool = new Map(
    latest.data?.map((entry) => [entry.toolKey, entry]),
  );

  const terminalEnvironment = useQuery({
    queryKey: qk.terminalEnvironment(),
    queryFn: () => detectTerminalEnvironment(false),
    staleTime: 30_000,
  });
  const launchTarget = useQuery({
    queryKey: qk.launchTarget(),
    queryFn: getLaunchTarget,
  });
  const launchTargetMutation = useMutation({
    mutationFn: (targetId: string) => setLaunchTarget(targetId),
    onSuccess: (_, targetId) => {
      queryClient.setQueryData(qk.launchTarget(), targetId);
      queryClient.invalidateQueries({ queryKey: ["preview"] });
    },
  });
  const currentLaunchTarget = launchTarget.data ?? "auto";
  const detectedLaunchTargets = new Set([
    "auto",
    ...(terminalEnvironment.data?.windowsTerminalHosts.flatMap((host) =>
      host.profiles.map((profile) => profile.targetId),
    ) ?? []),
    ...(terminalEnvironment.data?.directShells.map((shell) => shell.targetId) ??
      []),
    ...(terminalEnvironment.data?.macosTerminalHosts.map(
      (host) => host.targetId,
    ) ?? []),
  ]);
  const unavailableSavedTarget =
    currentLaunchTarget !== "auto" &&
    terminalEnvironment.data !== undefined &&
    !detectedLaunchTargets.has(currentLaunchTarget);

  const closeBehavior = useQuery({
    queryKey: qk.closeBehavior(),
    queryFn: getCloseBehavior,
  });
  const closeBehaviorMutation = useMutation({
    mutationFn: (value: CloseBehavior) => setCloseBehavior(value),
    onSuccess: (_, value) =>
      queryClient.setQueryData(qk.closeBehavior(), value),
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
      await saveToolGlobalArgsBatch(
        TOOLS.map((tool) => ({
          toolKey: tool.key,
          args: globalArgs[tool.key].trim(),
        })),
      );
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.tools() }),
  });

  const [pending, setPending] = useState<PendingAction | null>(null);
  const [planningToolKey, setPlanningToolKey] = useState<ToolKey | null>(null);
  const [actionError, setActionError] = useState<ActionError | null>(null);
  const popoverContainerRef = useRef<HTMLDivElement | null>(null);
  const [pendingRestore, setPendingRestore] = useState<BackupManifest | null>(
    null,
  );

  const backups = useQuery({
    queryKey: qk.backups(),
    queryFn: listBackups,
  });
  const createBackupMutation = useMutation({
    mutationFn: createBackup,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.backups() }),
  });
  const restoreBackupMutation = useMutation({
    mutationFn: (backupId: string) => restoreBackup(backupId),
    onSuccess: async () => {
      setPendingRestore(null);
      queryClient.removeQueries({ queryKey: qk.directoryToolArgs() });
      queryClient.removeQueries({ queryKey: ["sessions"] });
      await queryClient.invalidateQueries();
      const fresh = await queryClient.fetchQuery({
        queryKey: qk.tools(),
        queryFn: listTools,
      });
      setGlobalArgs(toolsToGlobalArgs(fresh));
    },
  });
  const launchHistory = useQuery({
    queryKey: qk.launchHistory(),
    queryFn: listLaunchHistory,
  });
  const clearHistoryMutation = useMutation({
    mutationFn: clearLaunchHistory,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: qk.launchHistory() }),
  });
  const cacheStats = useQuery({
    queryKey: qk.cacheStats(),
    queryFn: getCacheStats,
  });
  const clearCacheMutation = useMutation({
    mutationFn: clearCache,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: qk.cacheStats() });
      queryClient.invalidateQueries({ queryKey: qk.cliStatus() });
      queryClient.invalidateQueries({ queryKey: qk.latestVersions() });
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
  });
  const refreshDetectedVersions = async () => {
    await Promise.all([
      queryClient.fetchQuery({
        queryKey: qk.cliStatus(),
        queryFn: () => detectCliStatus(true),
      }),
      queryClient.fetchQuery({
        queryKey: qk.latestVersions(),
        queryFn: () => fetchLatestVersions(true),
      }),
      queryClient.fetchQuery({
        queryKey: qk.terminalEnvironment(),
        queryFn: () => detectTerminalEnvironment(true),
      }),
    ]);
    await queryClient.invalidateQueries({ queryKey: qk.cacheStats() });
  };

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
      queryClient.removeQueries({ queryKey: qk.directoryToolArgs() });
      queryClient.removeQueries({ queryKey: ["sessions"] });
      queryClient.invalidateQueries({ queryKey: qk.closeBehavior() });
      // Re-seed the global-args editor from the freshly imported tools (await
      // the fetch so we don't seed from stale data).
      const fresh = await queryClient.fetchQuery({
        queryKey: qk.tools(),
        queryFn: listTools,
      });
      setGlobalArgs(toolsToGlobalArgs(fresh));
      queryClient.invalidateQueries({ queryKey: qk.backups() });
    },
  });
  const diagnosticsMutation = useMutation({
    mutationFn: async () => {
      const path = await save({
        defaultPath: "cli-launchpad-diagnostics.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) {
        return false;
      }
      await exportDiagnosticsToPath(path);
      return true;
    },
  });

  const startAction = async (toolKey: ToolKey, kind: InstallKind) => {
    if (pending?.toolKey === toolKey && pending.kind === kind) {
      setPending(null);
      return;
    }
    setActionError(null);
    setPlanningToolKey(toolKey);
    try {
      const plan = await getInstallPlan(toolKey, kind);
      setPending({ toolKey, kind, plan });
    } catch (error) {
      setActionError({ toolKey, message: String(error) });
    } finally {
      setPlanningToolKey(null);
    }
  };

  const runMutation = useMutation({
    mutationFn: (action: PendingAction) =>
      startExecutionTask(action.toolKey, action.kind),
    onSuccess: (task) => {
      queryClient.setQueryData<ExecutionTask[]>(
        qk.executionTasks(),
        (entries) => upsertExecutionTask(entries, task),
      );
      setActionError(null);
      setPending(null);
      setView("executions");
    },
    onError: (error, action) => {
      setActionError({ toolKey: action.toolKey, message: String(error) });
    },
  });

  useEffect(() => {
    if (!pending || runMutation.isPending) {
      return;
    }
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (
        popoverContainerRef.current &&
        !popoverContainerRef.current.contains(event.target as Node)
      ) {
        setPending(null);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPending(null);
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [pending, runMutation.isPending]);

  return (
    <div className="settings-view">
      <header className="detail-head settings-head">
        <h1>设置</h1>
        <button
          className="icon-button"
          title="重新检测"
          onClick={() => {
            void refreshDetectedVersions();
          }}
          disabled={cliStatus.isFetching || latest.isFetching}
        >
          <RefreshCw
            size={15}
            className={clsx({
              spinning: cliStatus.isFetching || latest.isFetching,
            })}
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
          const latestEntry = latestByTool.get(tool.key);
          const latestVersion = latestEntry?.latest ?? null;
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
                  当前：
                  {status?.version ??
                    (isMissing
                      ? "—"
                      : status?.versionError
                        ? `无法获取（${status.versionError}）`
                        : "未知；点击右上角重新检测")}
                </span>
                <span>
                  最新：
                  {latest.isFetching
                    ? "查询中…"
                    : latestVersion
                      ? `${latestVersion}${latestEntry?.fromCache ? "（缓存）" : ""}`
                      : latestEntry?.error
                        ? `无法获取（${latestEntry.error}）`
                        : "无法获取"}
                </span>
              </div>

              <div className="cli-status-actions">
                {(isMissing || updatable === true) && (
                  <div
                    className="cli-action-anchor"
                    ref={
                      pending?.toolKey === tool.key
                        ? popoverContainerRef
                        : undefined
                    }
                  >
                    <button
                      className="primary-button"
                      onClick={() =>
                        void startAction(
                          tool.key,
                          isMissing ? "install" : "update",
                        )
                      }
                      disabled={
                        planningToolKey === tool.key ||
                        runMutation.isPending ||
                        activeTask != null
                      }
                      title={
                        activeTask ? "已有安装或更新任务正在执行" : undefined
                      }
                    >
                      <Download size={15} />
                      {planningToolKey === tool.key
                        ? "准备中…"
                        : isMissing
                          ? "一键安装"
                          : "更新"}
                    </button>
                    {pending?.toolKey === tool.key && (
                      <div
                        className="cli-action-popover"
                        role="dialog"
                        aria-label={
                          pending.kind === "install" ? "确认安装" : "确认更新"
                        }
                      >
                        <div className="section-heading">
                          {pending.kind === "install" ? "确认安装" : "确认更新"}
                        </div>
                        <p className="muted">来源：{pending.plan.source}</p>
                        <code className="readonly-args">
                          {pending.plan.preview}
                        </code>
                        <p className="muted">
                          该命令将在你的机器上执行。确认后可在“执行任务”中查看实时日志。
                        </p>
                        {actionError?.toolKey === tool.key && (
                          <p className="error">
                            执行失败：{actionError.message}
                          </p>
                        )}
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
                            {runMutation.isPending ? "创建任务中…" : "确认执行"}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
              {actionError?.toolKey === tool.key &&
                pending?.toolKey !== tool.key && (
                  <p className="error cli-action-message">
                    操作准备失败：{actionError.message}
                  </p>
                )}
              {activeTask && activeTask.toolKey === tool.key && (
                <p className="muted cli-action-message">
                  此工具当前有任务正在执行，可从左侧“执行任务”查看。
                </p>
              )}
            </div>
          );
        })}
      </section>

      <section className="shell-config">
        <div className="terminal-config-head">
          <div>
            <div className="section-heading">启动方式</div>
            <p className="muted">
              {terminalEnvironment.data?.platform === "macos"
                ? "自动模式固定使用 Terminal.app；第三方终端仅在明确选择后使用。"
                : terminalEnvironment.data?.platform === "windows"
                  ? "优先保留 Windows Terminal Profile；不可用时自动回退到独立 Shell。"
                  : "根据当前平台检测可用的终端启动方式。"}
            </p>
          </div>
          <button
            className="icon-button"
            title="重新检测终端环境"
            disabled={terminalEnvironment.isFetching}
            onClick={() => {
              void queryClient.fetchQuery({
                queryKey: qk.terminalEnvironment(),
                queryFn: () => detectTerminalEnvironment(true),
              });
            }}
          >
            <RefreshCw
              size={15}
              className={clsx({ spinning: terminalEnvironment.isFetching })}
            />
          </button>
        </div>

        {terminalEnvironment.isLoading || launchTarget.isLoading ? (
          <p className="muted">正在检测终端环境…</p>
        ) : terminalEnvironment.isError || launchTarget.isError ? (
          <p className="error">
            读取启动方式失败：
            {String(terminalEnvironment.error ?? launchTarget.error)}
          </p>
        ) : (
          <div className="terminal-option-list">
            <TerminalOption
              targetId="auto"
              title="自动选择"
              description={
                terminalEnvironment.data?.platform === "macos"
                  ? "固定使用系统 Terminal.app，安装第三方终端不会改变默认行为。"
                  : "优先使用 Windows Terminal 默认 Profile，再按 PowerShell 7、Windows PowerShell、CMD 回退。"
              }
              selected={currentLaunchTarget === "auto"}
              disabled={launchTargetMutation.isPending}
              badges={[{ label: "推荐", tone: "recommended" }]}
              onSelect={launchTargetMutation.mutate}
            />

            {terminalEnvironment.data?.windowsTerminalHosts.map((host) => (
              <div className="terminal-group" key={host.id}>
                <div className="terminal-group-title">
                  <strong>{host.displayName}</strong>
                  <span>{host.version ? `v${host.version}` : "版本未知"}</span>
                </div>
                {host.profiles.length === 0 ? (
                  <p className="muted terminal-empty">
                    未发现可选择的 Profile，自动模式仍会尝试默认 Profile。
                  </p>
                ) : (
                  host.profiles.map((profile) => (
                    <TerminalOption
                      key={profile.targetId}
                      targetId={profile.targetId}
                      title={profile.name}
                      description={`${shellFamilyLabel(profile.shellFamily)} · ${profile.preservationReason}`}
                      selected={currentLaunchTarget === profile.targetId}
                      disabled={launchTargetMutation.isPending}
                      badges={[
                        ...(profile.isDefault
                          ? [
                              {
                                label: "默认 Profile",
                                tone: "default" as const,
                              },
                            ]
                          : []),
                        preservationBadge(profile.preservation),
                      ]}
                      onSelect={launchTargetMutation.mutate}
                    />
                  ))
                )}
              </div>
            ))}

            {(terminalEnvironment.data?.directShells.length ?? 0) > 0 && (
              <div className="terminal-group">
                <div className="terminal-group-title">
                  <strong>独立控制台</strong>
                  <span>不使用 Windows Terminal Profile</span>
                </div>
                {terminalEnvironment.data?.directShells.map((shell) => (
                  <TerminalOption
                    key={shell.targetId}
                    targetId={shell.targetId}
                    title={shell.displayName}
                    description={`${shellFamilyLabel(shell.shellFamily)} · 回退优先级 ${shell.priority}`}
                    selected={currentLaunchTarget === shell.targetId}
                    disabled={launchTargetMutation.isPending}
                    badges={[{ label: "独立窗口", tone: "standalone" }]}
                    onSelect={launchTargetMutation.mutate}
                  />
                ))}
              </div>
            )}

            {terminalEnvironment.data?.platform === "macos" && (
              <div className="terminal-group">
                <div className="terminal-group-title">
                  <strong>macOS 终端</strong>
                  <span>
                    已检测 {terminalEnvironment.data.macosTerminalHosts.length}{" "}
                    项
                  </span>
                </div>
                {terminalEnvironment.data.macosTerminalHosts.length === 0 ? (
                  <p className="muted terminal-empty">
                    未检测到可用终端，自动启动暂不可用。
                  </p>
                ) : (
                  terminalEnvironment.data.macosTerminalHosts.map((host) => (
                    <TerminalOption
                      key={host.targetId}
                      targetId={host.targetId}
                      title={host.displayName}
                      description={macosTerminalDescription(host)}
                      selected={currentLaunchTarget === host.targetId}
                      disabled={launchTargetMutation.isPending}
                      badges={[
                        ...(host.targetId === "macos:terminal"
                          ? [
                              {
                                label: "系统默认",
                                tone: "default" as const,
                              },
                            ]
                          : []),
                        {
                          label: "原生",
                          tone: "native" as const,
                        },
                      ]}
                      onSelect={launchTargetMutation.mutate}
                    />
                  ))
                )}
              </div>
            )}
          </div>
        )}

        {unavailableSavedTarget && (
          <p className="terminal-warning">
            已保存的启动目标 {currentLaunchTarget}{" "}
            在当前平台不可用；实际启动时将自动回退到推荐终端。请选择当前列表中的终端可更新此设置。
          </p>
        )}

        {terminalEnvironment.data?.warnings.map((warning) => (
          <p className="terminal-warning" key={warning}>
            {warning}
          </p>
        ))}
        {launchTargetMutation.isError && (
          <p className="error">
            保存启动方式失败：{String(launchTargetMutation.error)}
          </p>
        )}
      </section>

      <section className="shell-config">
        <div className="section-heading">关闭窗口行为</div>
        <p className="muted">
          {terminalEnvironment.data?.platform === "macos"
            ? "默认关闭后保持后台运行；点击 Dock 图标或菜单栏入口可重新显示主界面。"
            : "默认关闭后保留在系统托盘；双击托盘图标可重新显示主界面。"}
        </p>
        <div className="model-presets">
          {CLOSE_BEHAVIOR_OPTIONS.map((option) => (
            <button
              key={option.value}
              className={clsx("preset-button", {
                active: closeBehavior.data === option.value,
              })}
              disabled={
                closeBehavior.isLoading || closeBehaviorMutation.isPending
              }
              onClick={() => closeBehaviorMutation.mutate(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        {closeBehaviorMutation.isError && (
          <p className="error">
            保存失败：{String(closeBehaviorMutation.error)}
          </p>
        )}
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

      <section className="config-backup">
        <div className="section-heading">诊断</div>
        <div className="config-actions">
          <button
            className="ghost-button"
            disabled={diagnosticsMutation.isPending}
            onClick={() => diagnosticsMutation.mutate()}
          >
            <Download size={15} />
            导出诊断报告
          </button>
        </div>
        {diagnosticsMutation.isError && (
          <p className="error">导出失败：{String(diagnosticsMutation.error)}</p>
        )}
      </section>

      <section className="config-backup">
        <div className="section-heading">最近启动</div>
        <div className="config-actions">
          <button
            className="ghost-button"
            disabled={clearHistoryMutation.isPending}
            onClick={() => clearHistoryMutation.mutate()}
          >
            清除历史
          </button>
        </div>
        <div className="backup-list">
          {launchHistory.data?.map((event) => (
            <div className="backup-row" key={event.id}>
              <div>
                <strong>
                  {event.directoryName} · {event.toolKey}
                </strong>
                <span className="muted">
                  {event.action === "resume" ? "恢复会话" : "新建会话"} ·{" "}
                  {event.success ? "成功" : "失败"} ·{" "}
                  {formatUtcDateTime(event.launchedAt)}
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="config-backup">
        <div className="section-heading">缓存</div>
        <div className="cache-summary">
          <span>条目：{cacheStats.data?.entryCount ?? 0}</span>
          <span>大小：{formatBytes(cacheStats.data?.sizeBytes ?? 0)}</span>
          <span>
            最近写入：
            {cacheStats.data?.newestEntryAtMs
              ? new Date(cacheStats.data.newestEntryAtMs).toLocaleString()
              : "无"}
          </span>
        </div>
        <div className="config-actions">
          <button
            className="ghost-button"
            disabled={clearCacheMutation.isPending}
            onClick={() => clearCacheMutation.mutate()}
          >
            清除缓存
          </button>
        </div>
      </section>

      <section className="config-backup">
        <div className="section-heading">数据恢复</div>
        <p className="muted">
          自动恢复点会在导入配置和恢复操作前创建；手动恢复点保存当前全部业务数据。
        </p>
        <div className="config-actions">
          <button
            className="primary-button"
            disabled={createBackupMutation.isPending}
            onClick={() => createBackupMutation.mutate()}
          >
            <Save size={15} />
            创建恢复点
          </button>
        </div>
        {backups.isError && (
          <p className="error">读取恢复点失败：{String(backups.error)}</p>
        )}
        <div className="backup-list">
          {backups.data?.map((backup) => (
            <div className="backup-row" key={backup.id}>
              <div>
                <strong>{backupReasonLabel(backup.reason)}</strong>
                <span className="muted">
                  {new Date(backup.createdAtMs).toLocaleString()} ·{" "}
                  {formatBytes(backup.sizeBytes)}
                </span>
              </div>
              <button
                className="ghost-button"
                disabled={restoreBackupMutation.isPending}
                onClick={() => setPendingRestore(backup)}
              >
                恢复
              </button>
            </div>
          ))}
        </div>
        {pendingRestore && (
          <div className="restore-confirm">
            <div className="section-heading">确认恢复数据</div>
            <p className="muted">
              将恢复到 {new Date(pendingRestore.createdAtMs).toLocaleString()}{" "}
              的数据状态；执行前会自动保存当前状态。
            </p>
            <div className="edit-actions">
              <button
                className="ghost-button"
                onClick={() => setPendingRestore(null)}
                disabled={restoreBackupMutation.isPending}
              >
                取消
              </button>
              <button
                className="primary-button"
                onClick={() => restoreBackupMutation.mutate(pendingRestore.id)}
                disabled={restoreBackupMutation.isPending}
              >
                确认恢复
              </button>
            </div>
          </div>
        )}
        {restoreBackupMutation.isError && (
          <p className="error">
            恢复失败：{String(restoreBackupMutation.error)}
          </p>
        )}
      </section>
    </div>
  );
}

function backupReasonLabel(reason: BackupManifest["reason"]) {
  const labels = {
    manual: "手动恢复点",
    pre_import: "导入前自动备份",
    pre_restore: "恢复前保护备份",
    pre_migration: "升级前自动备份",
  };
  return labels[reason];
}

type TerminalBadgeTone =
  | "recommended"
  | "default"
  | "exact"
  | "continuation"
  | "appearance"
  | "standalone"
  | "native";

interface TerminalOptionProps {
  targetId: string;
  title: string;
  description: string;
  selected: boolean;
  disabled: boolean;
  badges: { label: string; tone: TerminalBadgeTone }[];
  onSelect: (targetId: string) => void;
}

function TerminalOption({
  targetId,
  title,
  description,
  selected,
  disabled,
  badges,
  onSelect,
}: TerminalOptionProps) {
  return (
    <label className={clsx("terminal-option", { selected, disabled })}>
      <input
        type="radio"
        name="terminal-launch-target"
        value={targetId}
        checked={selected}
        disabled={disabled}
        onChange={() => onSelect(targetId)}
      />
      <span className="terminal-option-main">
        <span className="terminal-option-title">{title}</span>
        <span className="terminal-option-description">{description}</span>
      </span>
      <span className="terminal-option-badges">
        {badges.map((badge) => (
          <span
            className={clsx("terminal-option-badge", badge.tone)}
            key={`${badge.tone}:${badge.label}`}
          >
            {badge.label}
          </span>
        ))}
      </span>
    </label>
  );
}

function preservationBadge(preservation: ProfilePreservation): {
  label: string;
  tone: TerminalBadgeTone;
} {
  const badges = {
    exact: { label: "完整保留", tone: "exact" as const },
    command_continuation: {
      label: "命令续接",
      tone: "continuation" as const,
    },
    appearance_only: {
      label: "仅保留外观",
      tone: "appearance" as const,
    },
  };
  return badges[preservation];
}

function shellFamilyLabel(family: ShellFamily) {
  const labels: Record<ShellFamily, string> = {
    pwsh: "PowerShell 7",
    windows_power_shell: "Windows PowerShell",
    cmd: "CMD",
    unknown: "自定义 Shell",
  };
  return labels[family];
}

function macosTerminalDescription(
  host: import("../lib/tauri").MacosTerminalHost,
) {
  const version = host.version ? `v${host.version} · ` : "";
  const descriptions: Record<
    import("../lib/tauri").MacosTerminalLaunchMode,
    string
  > = {
    command_document: "通过 LaunchServices 打开一次性、自删除的 .command",
    apple_script: "通过 AppleScript 创建 Ghostty 原生窗口并输入命令",
    direct_arguments: "通过应用包内官方 CLI 传递结构化参数",
  };
  const launchDescription =
    host.targetId === "macos:kitty"
      ? `${descriptions.direct_arguments}，并保留命令退出后的窗口`
      : descriptions[host.launchMode];
  return `${version}${launchDescription} · ${host.applicationPath}`;
}

function formatBytes(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

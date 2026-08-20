import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Download, RefreshCw, Save, Upload } from "lucide-react";
import clsx from "clsx";
import { createRef, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { AnchoredPopover } from "../components/AnchoredPopover";
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

const CLOSE_BEHAVIOR_OPTIONS: {
  value: CloseBehavior;
  labelKey: "settings.closeMinimize" | "settings.closeQuit";
}[] = [
  { value: "minimize_to_tray", labelKey: "settings.closeMinimize" },
  { value: "quit", labelKey: "settings.closeQuit" },
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
  const { t, i18n } = useTranslation();
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
  const popoverAnchorRefs = useRef({
    claude: createRef<HTMLDivElement>(),
    codex: createRef<HTMLDivElement>(),
    antigravity: createRef<HTMLDivElement>(),
  }).current;
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

  return (
    <div className="settings-view">
      <header className="detail-head settings-head">
        <h1>{t("settings.title")}</h1>
        <button
          className="icon-button refresh-button"
          title={t("settings.refresh")}
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
        <div className="section-heading">{t("settings.cliStatus")}</div>
        {cliStatus.isError && (
          <p className="error">
            {t("settings.detectFailed", { error: String(cliStatus.error) })}
          </p>
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
                  {t(CLI_STATUS_META[availability].labelKey)}
                </span>
                {updatable === true && (
                  <span className="update-flag">
                    {t("settings.updateAvailable")}
                  </span>
                )}
                {(isMissing || updatable === true) && (
                  <div
                    className="cli-action-anchor"
                    ref={popoverAnchorRefs[tool.key]}
                  >
                    <button
                      className="primary-button cli-status-action-button"
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
                        activeTask ? t("settings.taskActiveTitle") : undefined
                      }
                    >
                      <Download size={15} />
                      {planningToolKey === tool.key
                        ? t("settings.preparing")
                        : isMissing
                          ? t("settings.install")
                          : t("settings.update")}
                    </button>
                    {pending?.toolKey === tool.key && (
                      <AnchoredPopover
                        anchorRef={popoverAnchorRefs[tool.key]}
                        ariaLabel={
                          pending.kind === "install"
                            ? t("settings.confirmInstall")
                            : t("settings.confirmUpdate")
                        }
                        dismissible={!runMutation.isPending}
                        onClose={() => setPending(null)}
                        header={
                          <div className="section-heading">
                            {pending.kind === "install"
                              ? t("settings.confirmInstall")
                              : t("settings.confirmUpdate")}
                          </div>
                        }
                        footer={
                          <>
                            <button
                              className="ghost-button"
                              onClick={() => setPending(null)}
                              disabled={runMutation.isPending}
                            >
                              {t("common.cancel")}
                            </button>
                            <button
                              className="primary-button"
                              onClick={() => runMutation.mutate(pending)}
                              disabled={runMutation.isPending}
                            >
                              {runMutation.isPending
                                ? t("settings.creatingTask")
                                : t("settings.confirmRun")}
                            </button>
                          </>
                        }
                      >
                        <p className="muted">
                          {t("settings.source", {
                            source: pending.plan.source,
                          })}
                        </p>
                        <code className="readonly-args">
                          {pending.plan.preview}
                        </code>
                        <p className="muted">{t("settings.commandNotice")}</p>
                        {actionError?.toolKey === tool.key && (
                          <p className="error">
                            {t("settings.executeFailed", {
                              error: actionError.message,
                            })}
                          </p>
                        )}
                      </AnchoredPopover>
                    )}
                  </div>
                )}
              </div>

              <div className="cli-status-detail muted">
                {status?.path && (
                  <span>{t("settings.path", { path: status.path })}</span>
                )}
                <span>
                  {t("settings.current")}
                  {status?.version ??
                    (isMissing
                      ? "—"
                      : status?.versionError
                        ? t("settings.unavailableWithError", {
                            error: status.versionError,
                          })
                        : t("settings.unknownRefresh"))}
                </span>
                <span>
                  {t("settings.latest")}
                  {latest.isFetching
                    ? t("settings.checking")
                    : latestVersion
                      ? `${latestVersion}${latestEntry?.fromCache ? t("settings.cachedSuffix") : ""}`
                      : latestEntry?.error
                        ? t("settings.unavailableWithError", {
                            error: latestEntry.error,
                          })
                        : t("settings.unavailable")}
                </span>
              </div>

              {actionError?.toolKey === tool.key &&
                pending?.toolKey !== tool.key && (
                  <p className="error cli-action-message">
                    {t("settings.prepareFailed", {
                      error: actionError.message,
                    })}
                  </p>
                )}
              {activeTask && activeTask.toolKey === tool.key && (
                <p className="muted cli-action-message">
                  {t("settings.taskRunning")}
                </p>
              )}
            </div>
          );
        })}
      </section>

      <section className="shell-config">
        <div className="terminal-config-head">
          <div>
            <div className="section-heading">{t("settings.launchMethod")}</div>
            <p className="muted">
              {terminalEnvironment.data?.platform === "macos"
                ? t("settings.launchHintMac")
                : terminalEnvironment.data?.platform === "windows"
                  ? t("settings.launchHintWindows")
                  : t("settings.launchHintOther")}
            </p>
          </div>
          <button
            className="icon-button refresh-button"
            title={t("settings.refreshTerminal")}
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
          <p className="muted">{t("settings.detectingTerminal")}</p>
        ) : terminalEnvironment.isError || launchTarget.isError ? (
          <p className="error">
            {t("settings.launchLoadFailed", {
              error: String(terminalEnvironment.error ?? launchTarget.error),
            })}
          </p>
        ) : (
          <div className="terminal-option-list">
            <TerminalOption
              targetId="auto"
              title={t("settings.autoSelect")}
              description={
                terminalEnvironment.data?.platform === "macos"
                  ? t("settings.autoDescriptionMac")
                  : t("settings.autoDescriptionWindows")
              }
              selected={currentLaunchTarget === "auto"}
              disabled={launchTargetMutation.isPending}
              badges={[
                { label: t("settings.recommended"), tone: "recommended" },
              ]}
              onSelect={launchTargetMutation.mutate}
            />

            {terminalEnvironment.data?.windowsTerminalHosts.map((host) => (
              <div className="terminal-group" key={host.id}>
                <div className="terminal-group-title">
                  <strong>{host.displayName}</strong>
                  <span>
                    {host.version
                      ? `v${host.version}`
                      : t("settings.unknownVersion")}
                  </span>
                </div>
                {host.profiles.length === 0 ? (
                  <p className="muted terminal-empty">
                    {t("settings.noProfiles")}
                  </p>
                ) : (
                  host.profiles.map((profile) => (
                    <TerminalOption
                      key={profile.targetId}
                      targetId={profile.targetId}
                      title={profile.name}
                      description={`${shellFamilyLabel(profile.shellFamily, t)} · ${profile.preservationReason}`}
                      selected={currentLaunchTarget === profile.targetId}
                      disabled={launchTargetMutation.isPending}
                      badges={[
                        ...(profile.isDefault
                          ? [
                              {
                                label: t("settings.defaultProfile"),
                                tone: "default" as const,
                              },
                            ]
                          : []),
                        preservationBadge(profile.preservation, t),
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
                  <strong>{t("settings.standaloneConsole")}</strong>
                  <span>{t("settings.standaloneDescription")}</span>
                </div>
                {terminalEnvironment.data?.directShells.map((shell) => (
                  <TerminalOption
                    key={shell.targetId}
                    targetId={shell.targetId}
                    title={shell.displayName}
                    description={`${shellFamilyLabel(shell.shellFamily, t)} · ${t("settings.fallbackPriority", { priority: shell.priority })}`}
                    selected={currentLaunchTarget === shell.targetId}
                    disabled={launchTargetMutation.isPending}
                    badges={[
                      {
                        label: t("settings.standaloneWindow"),
                        tone: "standalone",
                      },
                    ]}
                    onSelect={launchTargetMutation.mutate}
                  />
                ))}
              </div>
            )}

            {terminalEnvironment.data?.platform === "macos" && (
              <div className="terminal-group">
                <div className="terminal-group-title">
                  <strong>{t("settings.macTerminals")}</strong>
                  <span>
                    {t("settings.detectedCount", {
                      count: terminalEnvironment.data.macosTerminalHosts.length,
                    })}
                  </span>
                </div>
                {terminalEnvironment.data.macosTerminalHosts.length === 0 ? (
                  <p className="muted terminal-empty">
                    {t("settings.noTerminals")}
                  </p>
                ) : (
                  terminalEnvironment.data.macosTerminalHosts.map((host) => (
                    <TerminalOption
                      key={host.targetId}
                      targetId={host.targetId}
                      title={host.displayName}
                      description={macosTerminalDescription(host, t)}
                      selected={currentLaunchTarget === host.targetId}
                      disabled={launchTargetMutation.isPending}
                      badges={[
                        ...(host.targetId === "macos:terminal"
                          ? [
                              {
                                label: t("settings.systemDefault"),
                                tone: "default" as const,
                              },
                            ]
                          : []),
                        {
                          label: t("settings.native"),
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
            {t("settings.unavailableSavedTarget", {
              target: currentLaunchTarget,
            })}
          </p>
        )}

        {terminalEnvironment.data?.warnings.map((warning) => (
          <p className="terminal-warning" key={warning}>
            {warning}
          </p>
        ))}
        {launchTargetMutation.isError && (
          <p className="error">
            {t("settings.saveLaunchFailed", {
              error: String(launchTargetMutation.error),
            })}
          </p>
        )}
      </section>

      <section className="shell-config">
        <div className="section-heading">{t("settings.closeBehavior")}</div>
        <p className="muted">
          {terminalEnvironment.data?.platform === "macos"
            ? t("settings.closeDescriptionMac")
            : t("settings.closeDescriptionOther")}
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
              {t(option.labelKey)}
            </button>
          ))}
        </div>
        {closeBehaviorMutation.isError && (
          <p className="error">
            {t("settings.saveFailed", {
              error: String(closeBehaviorMutation.error),
            })}
          </p>
        )}
      </section>

      <section className="shell-config">
        <div className="section-heading">{t("settings.globalArgs")}</div>
        <p className="muted">{t("settings.globalArgsDescription")}</p>
        {TOOLS.map((tool) => (
          <div className="global-arg-row" key={tool.key}>
            <label className="global-arg-label">
              <tool.icon size={16} />
              {tool.label}
            </label>
            <input
              value={globalArgs[tool.key]}
              placeholder={t("settings.argsPlaceholder")}
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
            {t("settings.saveGlobalArgs")}
          </button>
          {saveGlobalArgsMutation.isSuccess && (
            <span className="muted">{t("settings.saved")}</span>
          )}
        </div>
      </section>

      <section className="config-backup">
        <div className="section-heading">{t("settings.configBackup")}</div>
        <p className="muted">{t("settings.configBackupDescription")}</p>
        <div className="config-actions">
          <button
            className="ghost-button"
            onClick={() => exportMutation.mutate()}
            disabled={exportMutation.isPending}
          >
            <Download size={15} />
            {t("settings.exportFile")}
          </button>
          <button
            className="ghost-button"
            onClick={() => importMutation.mutate()}
            disabled={importMutation.isPending}
          >
            <Upload size={15} />
            {t("settings.importFile")}
          </button>
        </div>
        {exportMutation.isSuccess && exportMutation.data && (
          <p className="muted">{t("settings.exported")}</p>
        )}
        {exportMutation.isError && (
          <p className="error">
            {t("settings.exportFailed", {
              error: String(exportMutation.error),
            })}
          </p>
        )}
        {importMutation.isSuccess && importMutation.data && (
          <p className="muted">{t("settings.importSuccess")}</p>
        )}
        {importMutation.isError && (
          <p className="error">
            {t("settings.importFailed", {
              error: String(importMutation.error),
            })}
          </p>
        )}
      </section>

      <section className="config-backup">
        <div className="section-heading">{t("settings.diagnostics")}</div>
        <div className="config-actions">
          <button
            className="ghost-button"
            disabled={diagnosticsMutation.isPending}
            onClick={() => diagnosticsMutation.mutate()}
          >
            <Download size={15} />
            {t("settings.exportDiagnostics")}
          </button>
        </div>
        {diagnosticsMutation.isError && (
          <p className="error">
            {t("settings.exportFailed", {
              error: String(diagnosticsMutation.error),
            })}
          </p>
        )}
      </section>

      <section className="config-backup">
        <div className="section-heading">{t("settings.recentLaunch")}</div>
        <div className="config-actions">
          <button
            className="ghost-button"
            disabled={clearHistoryMutation.isPending}
            onClick={() => clearHistoryMutation.mutate()}
          >
            {t("settings.clearHistory")}
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
                  {event.action === "resume"
                    ? t("settings.resumeSession")
                    : t("settings.newSession")}{" "}
                  ·{" "}
                  {event.success ? t("settings.success") : t("settings.failed")}{" "}
                  · {formatUtcDateTime(event.launchedAt, i18n.resolvedLanguage)}
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="config-backup">
        <div className="section-heading">{t("settings.cache")}</div>
        <div className="cache-summary">
          <span>
            {t("settings.entries", { count: cacheStats.data?.entryCount ?? 0 })}
          </span>
          <span>
            {t("settings.size", {
              size: formatBytes(cacheStats.data?.sizeBytes ?? 0),
            })}
          </span>
          <span>
            {t("settings.newestWrite", {
              time: cacheStats.data?.newestEntryAtMs
                ? new Date(cacheStats.data.newestEntryAtMs).toLocaleString(
                    i18n.resolvedLanguage,
                  )
                : t("common.none"),
            })}
          </span>
        </div>
        <div className="config-actions">
          <button
            className="ghost-button"
            disabled={clearCacheMutation.isPending}
            onClick={() => clearCacheMutation.mutate()}
          >
            {t("settings.clearCache")}
          </button>
        </div>
      </section>

      <section className="config-backup">
        <div className="section-heading">{t("settings.recovery")}</div>
        <p className="muted">{t("settings.recoveryDescription")}</p>
        <div className="config-actions">
          <button
            className="primary-button"
            disabled={createBackupMutation.isPending}
            onClick={() => createBackupMutation.mutate()}
          >
            <Save size={15} />
            {t("settings.createRecovery")}
          </button>
        </div>
        {backups.isError && (
          <p className="error">
            {t("settings.readRecoveryFailed", {
              error: String(backups.error),
            })}
          </p>
        )}
        <div className="backup-list">
          {backups.data?.map((backup) => (
            <div className="backup-row" key={backup.id}>
              <div>
                <strong>{backupReasonLabel(backup.reason, t)}</strong>
                <span className="muted">
                  {new Date(backup.createdAtMs).toLocaleString(
                    i18n.resolvedLanguage,
                  )}{" "}
                  · {formatBytes(backup.sizeBytes)}
                </span>
              </div>
              <button
                className="ghost-button"
                disabled={restoreBackupMutation.isPending}
                onClick={() => setPendingRestore(backup)}
              >
                {t("settings.restore")}
              </button>
            </div>
          ))}
        </div>
        {pendingRestore && (
          <div className="restore-confirm">
            <div className="section-heading">
              {t("settings.confirmRestore")}
            </div>
            <p className="muted">
              {t("settings.restoreDescription", {
                time: new Date(pendingRestore.createdAtMs).toLocaleString(
                  i18n.resolvedLanguage,
                ),
              })}
            </p>
            <div className="edit-actions">
              <button
                className="ghost-button"
                onClick={() => setPendingRestore(null)}
                disabled={restoreBackupMutation.isPending}
              >
                {t("common.cancel")}
              </button>
              <button
                className="primary-button"
                onClick={() => restoreBackupMutation.mutate(pendingRestore.id)}
                disabled={restoreBackupMutation.isPending}
              >
                {t("settings.confirmRestoreAction")}
              </button>
            </div>
          </div>
        )}
        {restoreBackupMutation.isError && (
          <p className="error">
            {t("settings.restoreFailed", {
              error: String(restoreBackupMutation.error),
            })}
          </p>
        )}
      </section>
    </div>
  );
}

function backupReasonLabel(reason: BackupManifest["reason"], t: TFunction) {
  return t(`settings.backupReason.${reason}`);
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

function preservationBadge(
  preservation: ProfilePreservation,
  t: TFunction,
): {
  label: string;
  tone: TerminalBadgeTone;
} {
  const badges = {
    exact: {
      label: t("settings.preservation.exact"),
      tone: "exact" as const,
    },
    command_continuation: {
      label: t("settings.preservation.command_continuation"),
      tone: "continuation" as const,
    },
    appearance_only: {
      label: t("settings.preservation.appearance_only"),
      tone: "appearance" as const,
    },
  };
  return badges[preservation];
}

function shellFamilyLabel(family: ShellFamily, t: TFunction) {
  const labels: Record<ShellFamily, string> = {
    pwsh: "PowerShell 7",
    windows_power_shell: "Windows PowerShell",
    cmd: "CMD",
    unknown: t("settings.shell.custom"),
  };
  return labels[family];
}

function macosTerminalDescription(
  host: import("../lib/tauri").MacosTerminalHost,
  t: TFunction,
) {
  const version = host.version ? `v${host.version} · ` : "";
  const descriptions: Record<
    import("../lib/tauri").MacosTerminalLaunchMode,
    string
  > = {
    command_document: t("settings.terminalDescription.command_document"),
    apple_script: t("settings.terminalDescription.apple_script"),
    direct_arguments: t("settings.terminalDescription.direct_arguments"),
  };
  const launchDescription =
    host.targetId === "macos:kitty"
      ? `${descriptions.direct_arguments}${t("settings.terminalDescription.kittySuffix")}`
      : descriptions[host.launchMode];
  return `${version}${launchDescription} · ${host.applicationPath}`;
}

function formatBytes(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

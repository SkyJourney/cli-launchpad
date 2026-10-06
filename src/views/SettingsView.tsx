import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Download, LoaderCircle, RefreshCw, Save, Upload } from "lucide-react";
import clsx from "clsx";
import { createRef, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { AnchoredPopover } from "../components/AnchoredPopover";
import { usePtyWorkspace } from "../components/PtyWorkspace";
import {
  CLI_STATUS_META,
  indexByTool,
  useCliStatus,
} from "../hooks/useCliStatus";
import {
  isExecutionActive,
  upsertExecutionTask,
  useExecutionReconciliations,
  useExecutionTasks,
} from "../hooks/useExecutionTasks";
import { formatUtcDateTime } from "../lib/format";
import { qk } from "../lib/queryKeys";
import { refreshInstallPlanConfirmation } from "../lib/installPlanConfirmation";
import { shouldQueryLatestVersion } from "../lib/versionQueryPolicy";
import { getAppErrorMessage } from "../lib/appErrors";
import {
  hasWorkspaceDataRestoreBlockers,
  type WorkspaceDataRestoreBlockers,
} from "../lib/workspaceRestorePolicy";
import {
  getLatestUpdateAvailability,
  isManagedUpdateAllowed,
  getCliAdapter,
  TOOLS,
} from "../lib/tools";
import {
  clearCache,
  clearLaunchHistory,
  createBackup,
  detectCliStatus,
  exportConfigToPath,
  exportDiagnosticsToPath,
  fetchLatestVersion,
  getCacheStats,
  getCloseBehavior,
  getLaunchHistoryLimit,
  getInstallPlan,
  importConfigFromPath,
  listBackups,
  listLaunchHistory,
  startExecutionTask,
  restoreBackup,
  setCloseBehavior,
  setLaunchHistoryLimit,
  type InstallKind,
  type InstallPlan,
  type ExecutionTask,
  type BackupManifest,
  type CloseBehavior,
  type ToolKey,
} from "../lib/tauri";

const CLOSE_BEHAVIOR_OPTIONS: {
  value: CloseBehavior;
  labelKey: "settings.closeMinimize" | "settings.closeQuit";
}[] = [
  { value: "minimize_to_tray", labelKey: "settings.closeMinimize" },
  { value: "quit", labelKey: "settings.closeQuit" },
];

interface PendingAction {
  toolKey: ToolKey;
  kind: InstallKind;
  plan: InstallPlan;
}

export function SettingsView() {
  const { t, i18n } = useTranslation();
  const { getBackupRestoreBlockers, cancelBackupRestore } = usePtyWorkspace();
  const queryClient = useQueryClient();
  const userAgent = navigator.userAgent;
  const platform = /Windows/i.test(userAgent)
    ? "windows"
    : /Macintosh|Mac OS X|MacPPC|MacIntel/i.test(userAgent)
      ? "macos"
      : "linux";
  const cliStatus = useCliStatus(true);
  const executionTasks = useExecutionTasks();
  const executionReconciliations = useExecutionReconciliations();
  const activeTaskByTool = new Map(
    executionTasks.data
      ?.filter((task) => isExecutionActive(task.status))
      .map((task) => [task.toolKey, task]),
  );
  const statusByTool = indexByTool(cliStatus.data);

  const latestQueries = useQueries({
    queries: TOOLS.map((tool) => ({
      queryKey: qk.latestVersion(tool.key),
      queryFn: () => fetchLatestVersion(tool.key, true),
      enabled: shouldQueryLatestVersion(
        executionTasks.isLoading,
        activeTaskByTool.has(tool.key),
      ),
      staleTime: 1000 * 60 * 30,
      refetchOnMount: "always" as const,
    })),
  });
  const latestQueryByTool = new Map<ToolKey, (typeof latestQueries)[number]>();
  TOOLS.forEach((tool, index) =>
    latestQueryByTool.set(tool.key, latestQueries[index]),
  );
  const latestIsFetching = latestQueries.some((query) => query.isFetching);

  const closeBehavior = useQuery({
    queryKey: qk.closeBehavior(),
    queryFn: getCloseBehavior,
  });
  const closeBehaviorMutation = useMutation({
    mutationFn: (value: CloseBehavior) => setCloseBehavior(value),
    onSuccess: (_, value) =>
      queryClient.setQueryData(qk.closeBehavior(), value),
  });

  const [pendingByTool, setPendingByTool] = useState<
    Partial<Record<ToolKey, PendingAction>>
  >({});
  const planningToolKeysRef = useRef(new Set<ToolKey>());
  const [planningToolKeys, setPlanningToolKeys] = useState<
    ReadonlySet<ToolKey>
  >(new Set());
  const creatingToolKeysRef = useRef(new Set<ToolKey>());
  const [creatingToolKeys, setCreatingToolKeys] = useState<
    ReadonlySet<ToolKey>
  >(new Set());
  const [actionErrors, setActionErrors] = useState<
    Partial<Record<ToolKey, string>>
  >({});
  const popoverAnchorRefs = useRef<
    Record<ToolKey, ReturnType<typeof createRef<HTMLDivElement>>>
  >({
    claude: createRef<HTMLDivElement>(),
    codex: createRef<HTMLDivElement>(),
    antigravity: createRef<HTMLDivElement>(),
    grok: createRef<HTMLDivElement>(),
    hermes: createRef<HTMLDivElement>(),
  }).current;
  const [pendingRestore, setPendingRestore] = useState<BackupManifest | null>(
    null,
  );
  const [restoreChecking, setRestoreChecking] = useState(false);
  const [restoreBlockers, setRestoreBlockers] =
    useState<WorkspaceDataRestoreBlockers | null>(null);
  const [restoreCheckError, setRestoreCheckError] = useState<string | null>(
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
      cancelBackupRestore();
      setPendingRestore(null);
      queryClient.removeQueries({ queryKey: ["sessions"] });
      await queryClient.invalidateQueries();
    },
    onError: () => cancelBackupRestore(),
  });
  const confirmBackupRestore = async () => {
    if (!pendingRestore || restoreChecking || restoreBackupMutation.isPending) {
      return;
    }
    setRestoreChecking(true);
    setRestoreCheckError(null);
    try {
      const blockers = await getBackupRestoreBlockers();
      setRestoreBlockers(blockers);
      if (hasWorkspaceDataRestoreBlockers(blockers)) {
        return;
      }
      restoreBackupMutation.mutate(pendingRestore.id);
    } catch (reason) {
      cancelBackupRestore();
      setRestoreCheckError(getAppErrorMessage(reason));
    } finally {
      setRestoreChecking(false);
    }
  };
  const launchHistory = useQuery({
    queryKey: qk.launchHistory(),
    queryFn: listLaunchHistory,
  });
  const launchHistoryLimit = useQuery({
    queryKey: qk.launchHistoryLimit(),
    queryFn: getLaunchHistoryLimit,
  });
  const launchHistoryLimitMutation = useMutation({
    mutationFn: setLaunchHistoryLimit,
    onSuccess: async (_, limit) => {
      queryClient.setQueryData(qk.launchHistoryLimit(), limit);
      await queryClient.invalidateQueries({ queryKey: qk.launchHistory() });
    },
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
      ...TOOLS.filter((tool) => !activeTaskByTool.has(tool.key)).map((tool) =>
        queryClient.fetchQuery({
          queryKey: qk.latestVersion(tool.key),
          queryFn: () => fetchLatestVersion(tool.key, true),
        }),
      ),
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
      queryClient.removeQueries({ queryKey: ["sessions"] });
      queryClient.invalidateQueries({ queryKey: qk.closeBehavior() });
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
    if (planningToolKeysRef.current.has(toolKey)) {
      return;
    }
    if (pendingByTool[toolKey]?.kind === kind) {
      clearPendingAction(toolKey);
      return;
    }
    clearActionError(toolKey);
    planningToolKeysRef.current.add(toolKey);
    setPlanningToolKeys(new Set(planningToolKeysRef.current));
    try {
      const plan = await getInstallPlan(toolKey, kind);
      setPendingByTool((current) => ({
        ...current,
        [toolKey]: { toolKey, kind, plan },
      }));
    } catch (error) {
      setActionErrors((current) => ({
        ...current,
        [toolKey]: String(error),
      }));
    } finally {
      planningToolKeysRef.current.delete(toolKey);
      setPlanningToolKeys(new Set(planningToolKeysRef.current));
    }
  };

  const clearPendingAction = (toolKey: ToolKey) => {
    setPendingByTool((current) => {
      const next = { ...current };
      delete next[toolKey];
      return next;
    });
  };

  const clearActionError = (toolKey: ToolKey) => {
    setActionErrors((current) => {
      const next = { ...current };
      delete next[toolKey];
      return next;
    });
  };

  const runAction = async (action: PendingAction) => {
    if (creatingToolKeysRef.current.has(action.toolKey)) {
      return;
    }
    creatingToolKeysRef.current.add(action.toolKey);
    setCreatingToolKeys(new Set(creatingToolKeysRef.current));
    clearActionError(action.toolKey);
    try {
      const task = await startExecutionTask(action.plan);
      queryClient.setQueryData<ExecutionTask[]>(
        qk.executionTasks(),
        (entries) => upsertExecutionTask(entries, task),
      );
      clearPendingAction(action.toolKey);
    } catch (error) {
      try {
        if (
          await refreshInstallPlanConfirmation({
            error,
            action,
            getPlan: getInstallPlan,
            setPending: (updated) =>
              setPendingByTool((current) => ({
                ...current,
                [updated.toolKey]: updated,
              })),
          })
        ) {
          return;
        }
      } catch (refreshError) {
        error = refreshError;
      }
      setActionErrors((current) => ({
        ...current,
        [action.toolKey]: String(error),
      }));
    } finally {
      creatingToolKeysRef.current.delete(action.toolKey);
      setCreatingToolKeys(new Set(creatingToolKeysRef.current));
    }
  };

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
          disabled={cliStatus.isFetching || latestIsFetching}
        >
          <RefreshCw
            size={15}
            className={clsx({
              spinning: cliStatus.isFetching || latestIsFetching,
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
          const availability = status?.status ?? "unknown";
          const latestQuery = latestQueryByTool.get(tool.key);
          const latestEntry = latestQuery?.data;
          const activeTask = activeTaskByTool.get(tool.key);
          const latestVersion = latestEntry?.latest ?? null;
          const updatable = getLatestUpdateAvailability(
            tool.key,
            status?.version ?? null,
            latestEntry,
          );
          const latestRefreshError =
            latestEntry?.error ??
            (latestQuery?.isError ? String(latestQuery.error) : null);
          const latestIsCached = Boolean(
            latestEntry?.fromCache ||
            (latestEntry && (latestQuery?.isFetching || latestQuery?.isError)),
          );
          const latestStatusAnnotation = [
            latestIsCached ? t("settings.cachedSuffix") : "",
            latestRefreshError
              ? t("settings.refreshFailedSuffix", {
                  error: latestRefreshError,
                })
              : "",
          ].join("");
          const isMissing = availability === "missing";
          const installEffects = tool.installEffects?.(platform);
          const updateAvailable =
            availability === "available" && updatable === true;
          const actionsAvailable =
            tool.settingsActions && tool.canManageSettings(platform);
          const canInstall =
            actionsAvailable && !cliStatus.isFetching && isMissing;
          const canUpdate =
            actionsAvailable &&
            updateAvailable &&
            isManagedUpdateAllowed(tool.key, latestEntry);
          const reconciliationKind = executionReconciliations.data[tool.key];
          const isReconciling = reconciliationKind != null;
          const busyKind = activeTask?.kind ?? reconciliationKind;
          const actionKind = isMissing ? "install" : "update";
          const pendingAction = pendingByTool[tool.key];
          const branchUpdateStatus = tool.latestStatusKind === "branch-update";
          const isCreatingTask = creatingToolKeys.has(tool.key);
          const isPlanning = planningToolKeys.has(tool.key);
          const actionError = actionErrors[tool.key];

          return (
            <div className="cli-status-row" key={tool.key}>
              <div className="cli-status-name">
                <tool.icon size={18} />
                <strong>{tool.label}</strong>
                <span
                  className={clsx(
                    "cli-badge",
                    isReconciling
                      ? "badge-refreshing"
                      : CLI_STATUS_META[availability].badgeClass,
                  )}
                >
                  {isReconciling
                    ? t("settings.refreshingVersion")
                    : t(CLI_STATUS_META[availability].labelKey)}
                </span>
                {updateAvailable && busyKind == null && (
                  <span className="update-flag">
                    {t("settings.updateAvailable")}
                  </span>
                )}
                {(busyKind || canInstall || canUpdate) && (
                  <div
                    className="cli-action-anchor"
                    ref={popoverAnchorRefs[tool.key]}
                  >
                    <button
                      onClick={() => void startAction(tool.key, actionKind)}
                      disabled={busyKind != null || isPlanning}
                      aria-busy={busyKind != null || isPlanning}
                      className={clsx(
                        "primary-button cli-status-action-button",
                        {
                          "is-running": activeTask != null,
                          "is-refreshing": isReconciling,
                        },
                      )}
                      title={
                        activeTask
                          ? t("settings.taskActiveTitle")
                          : isReconciling
                            ? t("settings.refreshingVersionTitle")
                            : isPlanning
                              ? t("settings.preparing")
                              : undefined
                      }
                    >
                      {busyKind || isPlanning ? (
                        <LoaderCircle size={14} className="spinning" />
                      ) : (
                        <Download size={14} />
                      )}
                      {isReconciling
                        ? t("settings.refreshingVersion")
                        : isPlanning
                          ? t("settings.preparing")
                          : activeTask
                            ? activeTask.kind === "install"
                              ? t("settings.installing")
                              : t("settings.updating")
                            : isMissing
                              ? t("settings.install")
                              : t("settings.update")}
                    </button>
                    {pendingAction && (
                      <AnchoredPopover
                        anchorRef={popoverAnchorRefs[tool.key]}
                        ariaLabel={
                          pendingAction.kind === "install"
                            ? t("settings.confirmInstall")
                            : t("settings.confirmUpdate")
                        }
                        className="cli-update-confirmation-popover"
                        dismissible={!isCreatingTask}
                        onClose={() => clearPendingAction(tool.key)}
                        header={
                          <div className="section-heading">
                            {pendingAction.kind === "install"
                              ? t("settings.confirmInstall")
                              : t("settings.confirmUpdate")}
                          </div>
                        }
                        footer={
                          <>
                            <button
                              className="ghost-button"
                              onClick={() => clearPendingAction(tool.key)}
                              disabled={isCreatingTask}
                            >
                              {t("common.cancel")}
                            </button>
                            <button
                              className="primary-button"
                              onClick={() => void runAction(pendingAction)}
                              disabled={isCreatingTask}
                            >
                              {isCreatingTask
                                ? t("settings.creatingTask")
                                : t("settings.confirmRun")}
                            </button>
                          </>
                        }
                      >
                        <p className="muted">
                          {t("settings.source", {
                            source: pendingAction.plan.source,
                          })}
                        </p>
                        <code className="readonly-args">
                          {pendingAction.plan.preview}
                        </code>
                        {pendingAction.kind === "install" && installEffects && (
                          <div className="cli-install-effects">
                            <p className="muted">
                              {t(installEffects.headingKey)}
                            </p>
                            <ul>
                              {installEffects.effectKeys.map((key) => (
                                <li key={key}>{t(key)}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {tool.showCommandNotice(pendingAction.kind) && (
                          <p className="muted">{t("settings.commandNotice")}</p>
                        )}
                        {actionError && (
                          <p className="error">
                            {t("settings.executeFailed", {
                              error: actionError,
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
                  {cliStatus.isFetching
                    ? t("settings.checking")
                    : (status?.version ??
                      (isMissing
                        ? "—"
                        : status?.versionError
                          ? t("settings.unavailableWithError", {
                              error: status.versionError,
                            })
                          : t("settings.unknownRefresh")))}
                </span>
                <span>
                  {branchUpdateStatus
                    ? t("settings.hermesUpdateStatus")
                    : t("settings.latest")}
                  {activeTask
                    ? t(
                        activeTask.kind === "install"
                          ? "settings.installing"
                          : "settings.updating",
                      )
                    : isReconciling
                      ? t("settings.refreshingVersion")
                      : latestQuery?.isFetching && !latestEntry
                        ? t("settings.checking")
                        : branchUpdateStatus
                          ? latestEntry?.updateAvailable === true
                            ? latestEntry.commitsBehind == null
                              ? `${t("settings.hermesUpdateBehindUnknown")}${latestStatusAnnotation}`
                              : `${t("settings.hermesUpdateBehind", {
                                  count: latestEntry.commitsBehind,
                                })}${latestStatusAnnotation}`
                            : latestEntry?.updateAvailable === false
                              ? `${t("settings.hermesUpToDate")}${latestStatusAnnotation}`
                              : availability === "missing"
                                ? "—"
                                : latestRefreshError
                                  ? t("settings.unavailableWithError", {
                                      error: latestRefreshError,
                                    })
                                  : t("settings.hermesRefreshPrompt")
                          : latestVersion
                            ? `${latestVersion}${latestStatusAnnotation}`
                            : latestRefreshError
                              ? t("settings.unavailableWithError", {
                                  error: latestRefreshError,
                                })
                              : t("settings.unavailable")}
                </span>
              </div>

              {!actionsAvailable && (
                <p className="muted cli-action-message">
                  {t("settings.managementComingSoon")}
                </p>
              )}

              {tool.showManagementMessage &&
                availability === "available" &&
                activeTask == null &&
                !isReconciling &&
                !latestQuery?.isFetching &&
                !latestEntry?.managedUpdateAllowed &&
                latestEntry?.managementMessage && (
                  <p className="muted cli-action-message">
                    {latestEntry.managementMessage}
                  </p>
                )}

              {actionError && !pendingAction && (
                <p className="error cli-action-message">
                  {t("settings.prepareFailed", {
                    error: actionError,
                  })}
                </p>
              )}
              {activeTask && (
                <p className="muted cli-action-message">
                  {t("settings.taskRunning")}
                </p>
              )}
              {isReconciling && (
                <p className="muted cli-action-message">
                  {t("settings.refreshingVersionDescription")}
                </p>
              )}
            </div>
          );
        })}
      </section>

      <section className="shell-config">
        <div className="section-heading">{t("settings.closeBehavior")}</div>
        <p className="muted">
          {/Macintosh|Mac OS X/i.test(navigator.userAgent)
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
          <label className="launch-history-retention">
            <span>{t("settings.launchHistoryRetention")}</span>
            <select
              value={launchHistoryLimit.data ?? 100}
              disabled={launchHistoryLimitMutation.isPending}
              onChange={(event) =>
                launchHistoryLimitMutation.mutate(Number(event.target.value))
              }
            >
              {[50, 100, 200, 500].map((limit) => (
                <option key={limit} value={limit}>
                  {t("settings.launchHistoryRetentionCount", { count: limit })}
                </option>
              ))}
            </select>
          </label>
          <button
            className="ghost-button"
            disabled={clearHistoryMutation.isPending}
            onClick={() => clearHistoryMutation.mutate()}
          >
            {t("settings.clearHistory")}
          </button>
        </div>
        <div className="backup-list settings-history-list">
          {launchHistory.data?.map((event) => {
            const tool = getCliAdapter(event.toolKey);
            const ToolIcon = tool.icon;
            return (
              <article className="launch-history-card" key={event.id}>
                <div className="launch-history-card-heading">
                  <span className="launch-history-tool">
                    <ToolIcon size={16} />
                    {tool.label}
                  </span>
                  <span className="muted">
                    {event.action === "resume"
                      ? t("settings.resumeSession")
                      : t("settings.newSession")}{" "}
                    ·{" "}
                    {event.success
                      ? t("settings.success")
                      : t("settings.failed")}{" "}
                  </span>
                </div>
                <div className="launch-history-card-details">
                  <span>
                    <strong>{t("settings.launchHistoryProject")}</strong>
                    {event.directoryName}
                  </span>
                  <span
                    className="launch-history-path"
                    title={event.directoryPath}
                  >
                    <strong>{t("settings.launchHistoryPath")}</strong>
                    {event.directoryPath}
                  </span>
                  <span>
                    <strong>{t("settings.launchHistoryTime")}</strong>
                    {formatUtcDateTime(event.launchedAt, i18n.resolvedLanguage)}
                  </span>
                  <span
                    className="launch-history-id"
                    title={event.ptySessionId ?? undefined}
                  >
                    <strong>{t("settings.launchHistorySessionId")}</strong>
                    <code>{event.ptySessionId ?? "—"}</code>
                  </span>
                </div>
              </article>
            );
          })}
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
        <div className="backup-list settings-history-list">
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
                disabled={restoreBackupMutation.isPending || restoreChecking}
                onClick={() => {
                  setRestoreBlockers(null);
                  setRestoreCheckError(null);
                  setPendingRestore(backup);
                }}
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
            {restoreBlockers &&
              hasWorkspaceDataRestoreBlockers(restoreBlockers) && (
                <ul className="error" role="alert">
                  {restoreBlockers.runningPtyCount > 0 && (
                    <li>
                      {t("settings.restoreBlockedPtys", {
                        count: restoreBlockers.runningPtyCount,
                      })}
                    </li>
                  )}
                  {restoreBlockers.dirtyFileCount > 0 && (
                    <li>
                      {t("settings.restoreBlockedDirtyFiles", {
                        count: restoreBlockers.dirtyFileCount,
                      })}
                    </li>
                  )}
                  {restoreBlockers.detachedWindowCount > 0 && (
                    <li>
                      {t("settings.restoreBlockedDetachedWindows", {
                        count: restoreBlockers.detachedWindowCount,
                      })}
                    </li>
                  )}
                </ul>
              )}
            {restoreCheckError && <p className="error">{restoreCheckError}</p>}
            <div className="edit-actions">
              <button
                className="ghost-button"
                onClick={() => setPendingRestore(null)}
                disabled={restoreBackupMutation.isPending || restoreChecking}
              >
                {t("common.cancel")}
              </button>
              <button
                className="primary-button"
                onClick={() => void confirmBackupRestore()}
                disabled={restoreBackupMutation.isPending || restoreChecking}
              >
                {restoreChecking
                  ? t("common.loading")
                  : t("settings.confirmRestoreAction")}
              </button>
            </div>
          </div>
        )}
        {restoreBackupMutation.isError && (
          <p className="error">
            {t("settings.restoreFailed", {
              error: getAppErrorMessage(restoreBackupMutation.error),
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

function formatBytes(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

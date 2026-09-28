import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Download, LoaderCircle, RefreshCw, Save, Upload } from "lucide-react";
import clsx from "clsx";
import { createRef, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { AnchoredPopover } from "../components/AnchoredPopover";
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
import { formatUtcDateTime, hasUpdate } from "../lib/format";
import { qk } from "../lib/queryKeys";
import { TOOLS } from "../lib/tools";
import {
  clearCache,
  clearLaunchHistory,
  createBackup,
  detectCliStatus,
  exportConfigToPath,
  exportDiagnosticsToPath,
  fetchLatestVersions,
  getCacheStats,
  getCloseBehavior,
  getInstallPlan,
  importConfigFromPath,
  listBackups,
  listLaunchHistory,
  startExecutionTask,
  restoreBackup,
  setCloseBehavior,
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
  const queryClient = useQueryClient();
  const cliStatus = useCliStatus(true);
  const executionTasks = useExecutionTasks();
  const executionReconciliations = useExecutionReconciliations();
  const activeTaskByTool = new Map(
    executionTasks.data
      ?.filter((task) => isExecutionActive(task.status))
      .map((task) => [task.toolKey, task]),
  );
  const statusByTool = indexByTool(cliStatus.data);

  const latest = useQuery({
    queryKey: qk.latestVersions(),
    queryFn: () => fetchLatestVersions(true),
    staleTime: 1000 * 60 * 30,
    refetchOnMount: "always",
  });
  const latestByTool = new Map(
    latest.data?.map((entry) => [entry.toolKey, entry]),
  );

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
  const creatingToolKeysRef = useRef(new Set<ToolKey>());
  const [creatingToolKeys, setCreatingToolKeys] = useState<
    ReadonlySet<ToolKey>
  >(new Set());
  const [actionErrors, setActionErrors] = useState<
    Partial<Record<ToolKey, string>>
  >({});
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
      queryClient.removeQueries({ queryKey: ["sessions"] });
      await queryClient.invalidateQueries();
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
      const task = await startExecutionTask(action.toolKey, action.kind);
      queryClient.setQueryData<ExecutionTask[]>(
        qk.executionTasks(),
        (entries) => upsertExecutionTask(entries, task),
      );
      clearPendingAction(action.toolKey);
    } catch (error) {
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
          const versionsRefreshing = cliStatus.isFetching || latest.isFetching;
          const updatable = versionsRefreshing
            ? null
            : hasUpdate(status?.version ?? null, latestVersion);
          const isMissing = availability === "missing";
          const canInstall = !cliStatus.isFetching && isMissing;
          const canUpdate = updatable === true;
          const activeTask = activeTaskByTool.get(tool.key);
          const reconciliationKind = executionReconciliations.data[tool.key];
          const isReconciling = reconciliationKind != null;
          const busyKind = activeTask?.kind ?? reconciliationKind;
          const actionKind = isMissing ? "install" : "update";
          const pendingAction = pendingByTool[tool.key];
          const isCreatingTask = creatingToolKeys.has(tool.key);
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
                {canUpdate && busyKind == null && (
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
                      disabled={busyKind != null}
                      aria-busy={busyKind != null}
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
                            : undefined
                      }
                    >
                      {busyKind ? (
                        <LoaderCircle size={15} className="spinning" />
                      ) : (
                        <Download size={15} />
                      )}
                      {isReconciling
                        ? t("settings.refreshingVersion")
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
                        <p className="muted">{t("settings.commandNotice")}</p>
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
          {/Macintosh|Mac OS X/i.test(navigator.userAgent) ? t("settings.closeDescriptionMac") : t("settings.closeDescriptionOther")}
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

function formatBytes(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

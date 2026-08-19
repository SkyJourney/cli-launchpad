import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { RefreshCw, Square, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  isExecutionActive,
  useExecutionTasks,
  upsertExecutionTask,
} from "../hooks/useExecutionTasks";
import { qk } from "../lib/queryKeys";
import { TOOLS } from "../lib/tools";
import {
  cancelExecutionTask,
  clearExecutionHistory,
  clearExecutionTask,
  getExecutionTask,
  type ExecutionStatus,
  type ExecutionTask,
} from "../lib/tauri";

const STATUS_META: Record<
  ExecutionStatus,
  { labelKey: string; className: string }
> = {
  preparing: {
    labelKey: "executions.status.preparing",
    className: "status-preparing",
  },
  running: {
    labelKey: "executions.status.running",
    className: "status-running",
  },
  cancelling: {
    labelKey: "executions.status.cancelling",
    className: "status-cancelling",
  },
  succeeded: {
    labelKey: "executions.status.succeeded",
    className: "status-succeeded",
  },
  failed: {
    labelKey: "executions.status.failed",
    className: "status-failed",
  },
  cancelled: {
    labelKey: "executions.status.cancelled",
    className: "status-cancelled",
  },
  timed_out: {
    labelKey: "executions.status.timed_out",
    className: "status-failed",
  },
  interrupted: {
    labelKey: "executions.status.interrupted",
    className: "status-interrupted",
  },
};

type Confirmation = "cancel" | "clear-one" | "clear-all" | null;

export function ExecutionsView() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const tasks = useExecutionTasks();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const [followLogs, setFollowLogs] = useState(false);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const entries = tasks.data ?? [];
    if (selectedId && entries.some((task) => task.id === selectedId)) {
      return;
    }
    const preferred =
      entries.find((task) => isExecutionActive(task.status)) ?? entries[0];
    setSelectedId(preferred?.id ?? null);
    setFollowLogs(preferred ? isExecutionActive(preferred.status) : false);
    setConfirmation(null);
  }, [selectedId, tasks.data]);

  const selectedSummary = tasks.data?.find((task) => task.id === selectedId);
  const detail = useQuery({
    queryKey: qk.executionTask(selectedId ?? ""),
    queryFn: () => getExecutionTask(selectedId as string),
    enabled: selectedId != null,
    refetchInterval:
      selectedSummary && isExecutionActive(selectedSummary.status)
        ? 2000
        : false,
  });
  const selectedTask = detail.data?.task ?? selectedSummary;
  const logs = detail.data?.logs ?? [];

  useEffect(() => {
    if (!followLogs || !logRef.current) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      if (logRef.current) {
        logRef.current.scrollTop = logRef.current.scrollHeight;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [followLogs, logs.length]);

  const cancelMutation = useMutation({
    mutationFn: (taskId: string) => cancelExecutionTask(taskId),
    onSuccess: (task) => {
      queryClient.setQueryData<ExecutionTask[]>(
        qk.executionTasks(),
        (entries) => upsertExecutionTask(entries, task),
      );
      setConfirmation(null);
    },
  });
  const clearOneMutation = useMutation({
    mutationFn: (taskId: string) => clearExecutionTask(taskId),
    onSuccess: (_, taskId) => {
      queryClient.removeQueries({ queryKey: qk.executionTask(taskId) });
      queryClient.setQueryData<ExecutionTask[]>(
        qk.executionTasks(),
        (entries) => entries?.filter((task) => task.id !== taskId),
      );
      setSelectedId(null);
      setConfirmation(null);
    },
  });
  const clearAllMutation = useMutation({
    mutationFn: clearExecutionHistory,
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: qk.executionTasks(),
        exact: true,
      });
      setSelectedId(null);
      setConfirmation(null);
    },
  });

  const finishedCount =
    tasks.data?.filter((task) => !isExecutionActive(task.status)).length ?? 0;
  const showUnifiedState = tasks.isLoading || tasks.data?.length === 0;
  const mutationError =
    cancelMutation.error ?? clearOneMutation.error ?? clearAllMutation.error;

  const selectTask = (task: ExecutionTask) => {
    setSelectedId(task.id);
    setFollowLogs(isExecutionActive(task.status));
    setConfirmation(null);
  };

  return (
    <div className="executions-view">
      <header className="execution-page-head">
        <div>
          <h1>{t("executions.title")}</h1>
          <p className="muted">{t("executions.description")}</p>
        </div>
        <div className="execution-page-actions">
          <button
            className="icon-button refresh-button"
            title={t("executions.refresh")}
            onClick={() => void tasks.refetch()}
            disabled={tasks.isFetching}
          >
            <RefreshCw
              size={15}
              className={clsx({ spinning: tasks.isFetching })}
            />
          </button>
          <button
            className="ghost-button danger-button page-cleanup-button"
            onClick={() => setConfirmation("clear-all")}
            disabled={finishedCount === 0}
          >
            <Trash2 size={15} />
            {t("executions.clearHistory")}
          </button>
        </div>
      </header>

      {confirmation === "clear-all" && (
        <div className="execution-confirm" role="alert">
          <div>
            <strong>{t("executions.clearAllTitle")}</strong>
            <p className="muted">
              {t("executions.clearAllDescription", { count: finishedCount })}
            </p>
          </div>
          <div className="execution-confirm-actions">
            <button
              className="ghost-button"
              onClick={() => setConfirmation(null)}
            >
              {t("common.cancel")}
            </button>
            <button
              className="primary-button danger-fill"
              onClick={() => clearAllMutation.mutate()}
              disabled={clearAllMutation.isPending}
            >
              {clearAllMutation.isPending
                ? t("executions.clearing")
                : t("executions.confirmClear")}
            </button>
          </div>
        </div>
      )}

      {tasks.isError && (
        <p className="error">
          {t("executions.readFailed", { error: String(tasks.error) })}
        </p>
      )}
      {mutationError && (
        <p className="error">
          {t("executions.operationFailed", {
            error: String(mutationError),
          })}
        </p>
      )}

      <section
        className={clsx("execution-layout", {
          "is-empty": showUnifiedState,
        })}
      >
        <div
          className="execution-task-list"
          aria-label={t("executions.listLabel")}
        >
          {tasks.isLoading && (
            <p className="muted execution-empty">
              {t("executions.readingTasks")}
            </p>
          )}
          {!tasks.isLoading && tasks.data?.length === 0 && (
            <div className="execution-empty">
              <strong>{t("executions.emptyTitle")}</strong>
              <p className="muted">{t("executions.emptyDescription")}</p>
            </div>
          )}
          {tasks.data?.map((task) => {
            const tool = TOOLS.find((entry) => entry.key === task.toolKey);
            const Icon = tool?.icon;
            return (
              <button
                key={task.id}
                className={clsx("execution-task-item", {
                  active: task.id === selectedId,
                })}
                onClick={() => selectTask(task)}
              >
                <span className="execution-task-title">
                  {Icon && <Icon size={18} />}
                  <strong>{tool?.label ?? task.toolKey}</strong>
                  <span>
                    {task.kind === "install"
                      ? t("executions.install")
                      : t("executions.update")}
                  </span>
                </span>
                <span className="execution-task-meta">
                  <TaskStatus status={task.status} />
                  <time>
                    {formatTaskTime(task.startedAtMs, i18n.resolvedLanguage)}
                  </time>
                </span>
              </button>
            );
          })}
        </div>

        {!showUnifiedState && (
          <div className="execution-detail">
            {!selectedTask && !tasks.isLoading && (
              <div className="execution-detail-empty muted">
                {t("executions.selectTask")}
              </div>
            )}
            {selectedTask && (
              <>
                <div className="execution-detail-head">
                  <div>
                    <div className="execution-detail-title">
                      <strong>
                        {taskTitle(
                          selectedTask,
                          t("executions.install"),
                          t("executions.update"),
                        )}
                      </strong>
                      <TaskStatus status={selectedTask.status} />
                    </div>
                    <p className="muted">
                      {t("executions.source", { source: selectedTask.source })}
                    </p>
                  </div>
                  <div className="execution-detail-actions">
                    {isExecutionActive(selectedTask.status) ? (
                      <button
                        className="ghost-button danger-button"
                        onClick={() => setConfirmation("cancel")}
                        disabled={
                          selectedTask.status === "cancelling" ||
                          cancelMutation.isPending
                        }
                      >
                        <Square size={13} fill="currentColor" />
                        {selectedTask.status === "cancelling"
                          ? t("executions.cancelling")
                          : t("executions.cancelTask")}
                      </button>
                    ) : (
                      <button
                        className="ghost-button danger-button"
                        onClick={() => setConfirmation("clear-one")}
                        disabled={clearOneMutation.isPending}
                      >
                        <Trash2 size={14} />
                        {t("executions.clearRecord")}
                      </button>
                    )}
                  </div>
                </div>

                <code className="execution-command">
                  {selectedTask.preview}
                </code>

                {confirmation === "cancel" && (
                  <div className="execution-confirm danger" role="alert">
                    <div>
                      <strong>{t("executions.cancelTitle")}</strong>
                      <p className="muted">
                        {t("executions.cancelDescription")}
                      </p>
                    </div>
                    <div className="execution-confirm-actions">
                      <button
                        className="ghost-button"
                        onClick={() => setConfirmation(null)}
                      >
                        {t("common.cancel")}
                      </button>
                      <button
                        className="primary-button danger-fill"
                        onClick={() => cancelMutation.mutate(selectedTask.id)}
                        disabled={cancelMutation.isPending}
                      >
                        {cancelMutation.isPending
                          ? t("executions.requesting")
                          : t("executions.confirmCancel")}
                      </button>
                    </div>
                  </div>
                )}

                {confirmation === "clear-one" && (
                  <div className="execution-confirm" role="alert">
                    <div>
                      <strong>{t("executions.deleteTitle")}</strong>
                      <p className="muted">
                        {t("executions.deleteDescription")}
                      </p>
                    </div>
                    <div className="execution-confirm-actions">
                      <button
                        className="ghost-button"
                        onClick={() => setConfirmation(null)}
                      >
                        {t("common.cancel")}
                      </button>
                      <button
                        className="primary-button danger-fill"
                        onClick={() => clearOneMutation.mutate(selectedTask.id)}
                        disabled={clearOneMutation.isPending}
                      >
                        {clearOneMutation.isPending
                          ? t("executions.deleting")
                          : t("executions.confirmDelete")}
                      </button>
                    </div>
                  </div>
                )}

                <div className="execution-log-toolbar">
                  <span className="muted">
                    {t("executions.startedAt", {
                      time: new Date(selectedTask.startedAtMs).toLocaleString(
                        i18n.resolvedLanguage,
                      ),
                    })}
                    {selectedTask.exitCode != null &&
                      ` · ${t("executions.exitCode", {
                        code: selectedTask.exitCode,
                      })}`}
                  </span>
                  {isExecutionActive(selectedTask.status) && !followLogs && (
                    <button
                      className="log-follow-button"
                      onClick={() => setFollowLogs(true)}
                    >
                      {t("executions.followOutput")}
                    </button>
                  )}
                </div>

                <div
                  className="execution-log"
                  ref={logRef}
                  aria-live="polite"
                  onScroll={(event) => {
                    if (!isExecutionActive(selectedTask.status)) {
                      return;
                    }
                    const target = event.currentTarget;
                    const nearBottom =
                      target.scrollHeight -
                        target.scrollTop -
                        target.clientHeight <
                      48;
                    setFollowLogs(nearBottom);
                  }}
                >
                  {detail.isLoading && (
                    <span className="muted">{t("executions.readingLogs")}</span>
                  )}
                  {!detail.isLoading && logs.length === 0 && (
                    <span className="execution-log-placeholder">
                      {t("executions.noOutput")}
                    </span>
                  )}
                  {logs.map((chunk) => (
                    <div
                      className={clsx(
                        "execution-log-chunk",
                        `stream-${chunk.stream}`,
                      )}
                      key={chunk.sequence}
                    >
                      <span className="execution-stream-label">
                        {t(`executions.stream.${chunk.stream}`)}
                      </span>
                      <pre>{chunk.content}</pre>
                    </div>
                  ))}
                  {selectedTask.logTruncated && (
                    <div className="execution-log-truncated">
                      {t("executions.truncated")}
                    </div>
                  )}
                </div>

                {selectedTask.errorMessage && (
                  <p className="error execution-task-error">
                    {selectedTask.errorMessage}
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function TaskStatus({ status }: { status: ExecutionStatus }) {
  const { t } = useTranslation();
  const meta = STATUS_META[status];
  return (
    <span className={clsx("execution-status", meta.className)}>
      {isExecutionActive(status) && <span className="execution-status-dot" />}
      {t(meta.labelKey)}
    </span>
  );
}

function taskTitle(
  task: ExecutionTask,
  installLabel: string,
  updateLabel: string,
) {
  const tool = TOOLS.find((entry) => entry.key === task.toolKey);
  return `${tool?.label ?? task.toolKey} ${
    task.kind === "install" ? installLabel : updateLabel
  }`;
}

function formatTaskTime(timestamp: number, language = "en") {
  const date = new Date(timestamp);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString(language, {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return date.toLocaleDateString(language, {
    month: "2-digit",
    day: "2-digit",
  });
}

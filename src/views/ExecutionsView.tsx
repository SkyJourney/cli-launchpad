import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { RefreshCw, Square, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
  type ExecutionStream,
  type ExecutionTask,
} from "../lib/tauri";

const STATUS_META: Record<
  ExecutionStatus,
  { label: string; className: string }
> = {
  preparing: { label: "准备中", className: "status-preparing" },
  running: { label: "执行中", className: "status-running" },
  cancelling: { label: "正在终止", className: "status-cancelling" },
  succeeded: { label: "执行成功", className: "status-succeeded" },
  failed: { label: "执行失败", className: "status-failed" },
  cancelled: { label: "已取消", className: "status-cancelled" },
  timed_out: { label: "已超时", className: "status-failed" },
  interrupted: { label: "意外中断", className: "status-interrupted" },
};

const STREAM_LABELS: Record<ExecutionStream, string> = {
  stdout: "输出",
  stderr: "错误",
  system: "系统",
};

type Confirmation = "cancel" | "clear-one" | "clear-all" | null;

export function ExecutionsView() {
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
          <h1>执行任务</h1>
          <p className="muted">查看安装与更新任务的实时输出和历史日志。</p>
        </div>
        <div className="execution-page-actions">
          <button
            className="icon-button"
            title="刷新任务"
            onClick={() => void tasks.refetch()}
            disabled={tasks.isFetching}
          >
            <RefreshCw
              size={15}
              className={clsx({ spinning: tasks.isFetching })}
            />
          </button>
          <button
            className="ghost-button danger-button"
            onClick={() => setConfirmation("clear-all")}
            disabled={finishedCount === 0}
          >
            <Trash2 size={15} />
            清理历史
          </button>
        </div>
      </header>

      {confirmation === "clear-all" && (
        <div className="execution-confirm" role="alert">
          <div>
            <strong>清理全部已结束任务？</strong>
            <p className="muted">
              将删除 {finishedCount} 条任务及其日志，无法撤销。
            </p>
          </div>
          <div className="execution-confirm-actions">
            <button
              className="ghost-button"
              onClick={() => setConfirmation(null)}
            >
              取消
            </button>
            <button
              className="primary-button danger-fill"
              onClick={() => clearAllMutation.mutate()}
              disabled={clearAllMutation.isPending}
            >
              {clearAllMutation.isPending ? "清理中…" : "确认清理"}
            </button>
          </div>
        </div>
      )}

      {tasks.isError && (
        <p className="error">读取任务失败：{String(tasks.error)}</p>
      )}
      {mutationError && (
        <p className="error">操作失败：{String(mutationError)}</p>
      )}

      <section
        className={clsx("execution-layout", {
          "is-empty": showUnifiedState,
        })}
      >
        <div className="execution-task-list" aria-label="执行任务列表">
          {tasks.isLoading && (
            <p className="muted execution-empty">正在读取任务…</p>
          )}
          {!tasks.isLoading && tasks.data?.length === 0 && (
            <div className="execution-empty">
              <strong>还没有执行任务</strong>
              <p className="muted">
                从设置页安装或更新 CLI 后，任务会显示在这里。
              </p>
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
                  <span>{task.kind === "install" ? "安装" : "更新"}</span>
                </span>
                <span className="execution-task-meta">
                  <TaskStatus status={task.status} />
                  <time>{formatTaskTime(task.startedAtMs)}</time>
                </span>
              </button>
            );
          })}
        </div>

        {!showUnifiedState && (
          <div className="execution-detail">
            {!selectedTask && !tasks.isLoading && (
              <div className="execution-detail-empty muted">
                选择一个任务查看执行日志。
              </div>
            )}
            {selectedTask && (
              <>
                <div className="execution-detail-head">
                  <div>
                    <div className="execution-detail-title">
                      <strong>{taskTitle(selectedTask)}</strong>
                      <TaskStatus status={selectedTask.status} />
                    </div>
                    <p className="muted">来源：{selectedTask.source}</p>
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
                          ? "正在终止"
                          : "终止任务"}
                      </button>
                    ) : (
                      <button
                        className="ghost-button danger-button"
                        onClick={() => setConfirmation("clear-one")}
                        disabled={clearOneMutation.isPending}
                      >
                        <Trash2 size={14} />
                        清理记录
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
                      <strong>确定终止此任务？</strong>
                      <p className="muted">
                        将强制结束完整进程树。更新中断可能导致 CLI
                        需要重新安装。
                      </p>
                    </div>
                    <div className="execution-confirm-actions">
                      <button
                        className="ghost-button"
                        onClick={() => setConfirmation(null)}
                      >
                        取消
                      </button>
                      <button
                        className="primary-button danger-fill"
                        onClick={() => cancelMutation.mutate(selectedTask.id)}
                        disabled={cancelMutation.isPending}
                      >
                        {cancelMutation.isPending ? "正在请求…" : "确认终止"}
                      </button>
                    </div>
                  </div>
                )}

                {confirmation === "clear-one" && (
                  <div className="execution-confirm" role="alert">
                    <div>
                      <strong>删除这条任务记录？</strong>
                      <p className="muted">
                        对应的历史日志也会一并删除，无法撤销。
                      </p>
                    </div>
                    <div className="execution-confirm-actions">
                      <button
                        className="ghost-button"
                        onClick={() => setConfirmation(null)}
                      >
                        取消
                      </button>
                      <button
                        className="primary-button danger-fill"
                        onClick={() => clearOneMutation.mutate(selectedTask.id)}
                        disabled={clearOneMutation.isPending}
                      >
                        {clearOneMutation.isPending ? "删除中…" : "确认删除"}
                      </button>
                    </div>
                  </div>
                )}

                <div className="execution-log-toolbar">
                  <span className="muted">
                    开始于 {new Date(selectedTask.startedAtMs).toLocaleString()}
                    {selectedTask.exitCode != null &&
                      ` · 退出码 ${selectedTask.exitCode}`}
                  </span>
                  {isExecutionActive(selectedTask.status) && !followLogs && (
                    <button
                      className="log-follow-button"
                      onClick={() => setFollowLogs(true)}
                    >
                      跟随最新输出
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
                    <span className="muted">正在读取日志…</span>
                  )}
                  {!detail.isLoading && logs.length === 0 && (
                    <span className="execution-log-placeholder">
                      （暂无输出）
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
                        {STREAM_LABELS[chunk.stream]}
                      </span>
                      <pre>{chunk.content}</pre>
                    </div>
                  ))}
                  {selectedTask.logTruncated && (
                    <div className="execution-log-truncated">
                      日志已达到 1 MiB 上限，后续输出未保存。
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
  const meta = STATUS_META[status];
  return (
    <span className={clsx("execution-status", meta.className)}>
      {isExecutionActive(status) && <span className="execution-status-dot" />}
      {meta.label}
    </span>
  );
}

function taskTitle(task: ExecutionTask) {
  const tool = TOOLS.find((entry) => entry.key === task.toolKey);
  return `${tool?.label ?? task.toolKey} ${task.kind === "install" ? "安装" : "更新"}`;
}

function formatTaskTime(timestamp: number) {
  const date = new Date(timestamp);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString([], { month: "2-digit", day: "2-digit" });
}

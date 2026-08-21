import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { toast } from "sonner";
import { i18n } from "../i18n";
import { qk } from "../lib/queryKeys";
import { TOOLS } from "../lib/tools";
import {
  detectCliStatus,
  listExecutionTasks,
  type ExecutionLogChunk,
  type ExecutionStatus,
  type ExecutionTask,
  type ExecutionTaskDetail,
  type InstallKind,
  type ToolKey,
} from "../lib/tauri";

export type ExecutionReconciliations = Partial<Record<ToolKey, InstallKind>>;

export const ACTIVE_EXECUTION_STATUSES: ReadonlySet<ExecutionStatus> = new Set([
  "preparing",
  "running",
  "cancelling",
]);

export function isExecutionActive(status: ExecutionStatus) {
  return ACTIVE_EXECUTION_STATUSES.has(status);
}

export function upsertExecutionTask(
  tasks: ExecutionTask[] | undefined,
  task: ExecutionTask,
) {
  const next = (tasks ?? []).filter((entry) => entry.id !== task.id);
  next.push(task);
  return next.sort((left, right) => right.startedAtMs - left.startedAtMs);
}

export function useExecutionTasks() {
  return useQuery({
    queryKey: qk.executionTasks(),
    queryFn: listExecutionTasks,
    refetchInterval: (query) => {
      const tasks = query.state.data;
      return tasks?.some((task) => isExecutionActive(task.status))
        ? 2000
        : false;
    },
  });
}

export function useExecutionReconciliations() {
  return useQuery<ExecutionReconciliations>({
    queryKey: qk.executionReconciliations(),
    queryFn: async () => ({}),
    initialData: {},
    enabled: false,
    staleTime: Infinity,
  });
}

export function useExecutionTaskEvents() {
  const queryClient = useQueryClient();

  useEffect(() => {
    let disposed = false;
    const unlisten: UnlistenFn[] = [];

    const register = async () => {
      const taskUnlisten = await listen<ExecutionTask>(
        "execution-task-updated",
        (event) => {
          const task = event.payload;
          queryClient.setQueryData<ExecutionTask[]>(
            qk.executionTasks(),
            (tasks) => upsertExecutionTask(tasks, task),
          );
          queryClient.setQueryData<ExecutionTaskDetail>(
            qk.executionTask(task.id),
            (detail) => (detail ? { ...detail, task } : detail),
          );

          if (!isExecutionActive(task.status)) {
            queryClient.setQueryData<ExecutionReconciliations>(
              qk.executionReconciliations(),
              (current) => ({ ...current, [task.toolKey]: task.kind }),
            );
            showTaskCompletionToast(task);
            void queryClient.invalidateQueries({
              queryKey: qk.executionTask(task.id),
            });
            void queryClient
              .fetchQuery({
                queryKey: qk.cliStatus(),
                queryFn: () => detectCliStatus(true),
              })
              .finally(() => {
                queryClient.setQueryData<ExecutionReconciliations>(
                  qk.executionReconciliations(),
                  (current) => {
                    const next = { ...current };
                    delete next[task.toolKey];
                    return next;
                  },
                );
              });
          }
        },
      );
      if (disposed) {
        taskUnlisten();
      } else {
        unlisten.push(taskUnlisten);
      }

      const logUnlisten = await listen<ExecutionLogChunk>(
        "execution-task-log",
        (event) => {
          const chunk = event.payload;
          queryClient.setQueryData<ExecutionTaskDetail>(
            qk.executionTask(chunk.taskId),
            (detail) => {
              if (!detail) {
                return detail;
              }
              if (
                detail.logs.some((entry) => entry.sequence === chunk.sequence)
              ) {
                return detail;
              }
              return {
                ...detail,
                logs: [...detail.logs, chunk].sort(
                  (left, right) => left.sequence - right.sequence,
                ),
              };
            },
          );
        },
      );
      if (disposed) {
        logUnlisten();
      } else {
        unlisten.push(logUnlisten);
      }
    };

    void register();
    return () => {
      disposed = true;
      for (const stop of unlisten) {
        stop();
      }
    };
  }, [queryClient]);
}

function showTaskCompletionToast(task: ExecutionTask) {
  const tool = TOOLS.find((entry) => entry.key === task.toolKey);
  const toolLabel = tool?.label ?? task.toolKey;
  const operation = i18n.t(
    task.kind === "install"
      ? "executions.operationInstall"
      : "executions.operationUpdate",
  );
  const title = i18n.t("executions.taskToastTitle", {
    tool: toolLabel,
    operation,
  });
  const options = {
    id: `execution-task-${task.id}`,
    description: task.errorMessage ?? undefined,
  };

  switch (task.status) {
    case "succeeded":
      toast.success(i18n.t("executions.taskSucceededToast", { title }), {
        id: options.id,
      });
      break;
    case "failed":
    case "timed_out":
      toast.error(i18n.t("executions.taskFailedToast", { title }), options);
      break;
    case "cancelled":
    case "interrupted":
      toast.warning(i18n.t("executions.taskStoppedToast", { title }), options);
      break;
    default:
      break;
  }
}

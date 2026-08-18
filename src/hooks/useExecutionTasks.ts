import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { qk } from "../lib/queryKeys";
import {
  detectCliStatus,
  fetchLatestVersions,
  listExecutionTasks,
  type ExecutionLogChunk,
  type ExecutionStatus,
  type ExecutionTask,
  type ExecutionTaskDetail,
} from "../lib/tauri";

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
            void queryClient.invalidateQueries({
              queryKey: qk.executionTask(task.id),
            });
            void Promise.allSettled([
              queryClient.fetchQuery({
                queryKey: qk.cliStatus(),
                queryFn: () => detectCliStatus(true),
              }),
              queryClient.fetchQuery({
                queryKey: qk.latestVersions(),
                queryFn: () => fetchLatestVersions(true),
              }),
            ]);
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

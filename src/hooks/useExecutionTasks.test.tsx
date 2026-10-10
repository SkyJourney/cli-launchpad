// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "sonner",
  async () => (await import("../test/host/hostMocks")).sonnerMock,
);

import { i18n } from "../i18n";
import { qk } from "../lib/queryKeys";
import type {
  CliStatus,
  ExecutionTask,
  ExecutionTaskDetail,
} from "../lib/tauri";
import { tauriMock } from "../test/tauriMock";
import { toastSpy } from "../test/host/hostMocks";
import { useExecutionTaskEvents } from "./useExecutionTasks";

const BASE: ExecutionTask = {
  id: "t1",
  toolKey: "codex",
  kind: "update",
  source: "native updater",
  preview: "codex update",
  status: "running",
  startedAtMs: 1,
  finishedAtMs: null,
  exitCode: null,
  errorMessage: null,
  logTruncated: false,
};

const CODEX_STATUS: CliStatus = {
  toolKey: "codex",
  status: "available",
  path: "/tools/codex",
  resolvedCommand: "codex",
  version: null,
  versionError: null,
  latestVersion: null,
};

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function emitTask(task: ExecutionTask) {
  await act(async () => {
    tauriMock.emitEvent("execution-task-updated", task);
  });
  await settle();
}

async function emitLog(sequence: number) {
  await act(async () => {
    tauriMock.emitEvent("execution-task-log", {
      taskId: "t1",
      sequence,
      stream: "stdout",
      content: `c${sequence}`,
      createdAtMs: 1,
    });
  });
  await settle();
}

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(qk.executionTasks(), []);
  queryClient.setQueryData<ExecutionTaskDetail>(qk.executionTask("t1"), {
    task: BASE,
    logs: [],
  });
  queryClient.setQueryData(qk.executionReconciliations(), {});
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const hook = renderHook(() => useExecutionTaskEvents(), { wrapper });
  return { queryClient, hook };
}

const detectCalls = () =>
  tauriMock.state.invokeCalls.filter(
    (call) => call.command === "detect_cli_status",
  );

describe("useExecutionTaskEvents", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    tauriMock.setInvokeHandler((command) =>
      command === "detect_cli_status" ? [CODEX_STATUS] : undefined,
    );
  });

  afterEach(async () => {
    cleanup();
    await settle();
    expect(tauriMock.state.eventListeners).toHaveLength(0);
  });

  it("upserts task updates and shows one completion toast", async () => {
    const { queryClient } = setup();
    await settle();

    await emitTask({
      ...BASE,
      status: "succeeded",
      finishedAtMs: 2,
      exitCode: 0,
    });

    const tasks = queryClient.getQueryData<ExecutionTask[]>(
      qk.executionTasks(),
    );
    expect(tasks).toHaveLength(1);
    expect(tasks?.[0]).toMatchObject({ id: "t1", status: "succeeded" });
    expect(toastSpy.success).toHaveBeenCalledTimes(1);
    expect(toastSpy.success).toHaveBeenCalledWith("Codex update succeeded", {
      id: "execution-task-t1",
    });
    // 反向断言：成功路径不弹错误或警告。
    expect(toastSpy.error).not.toHaveBeenCalled();
    expect(toastSpy.warning).not.toHaveBeenCalled();
  });

  it("refreshes only the completed tool's status", async () => {
    setup();
    await settle();

    await emitTask({
      ...BASE,
      status: "succeeded",
      finishedAtMs: 2,
      exitCode: 0,
    });

    const calls = detectCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual({ toolKey: "codex", force: true });
    // 反向断言：codex 的 refreshLatestAfterExecution 为 false，不查询最新版本。
    expect(
      tauriMock.state.invokeCalls.filter(
        (call) => call.command === "fetch_latest_version",
      ),
    ).toHaveLength(0);
  });

  it("does not regress a terminal task to running on a stale update", async () => {
    const { queryClient } = setup();
    await settle();

    await emitTask({
      ...BASE,
      status: "succeeded",
      finishedAtMs: 2,
      exitCode: 0,
    });
    await emitTask({ ...BASE, status: "running" });

    const tasks = queryClient.getQueryData<ExecutionTask[]>(
      qk.executionTasks(),
    );
    expect(tasks?.find((task) => task.id === "t1")?.status).toBe("succeeded");
    expect(
      queryClient.getQueryData<ExecutionTaskDetail>(qk.executionTask("t1"))
        ?.task.status,
    ).toBe("succeeded");
    // 反向断言：过期的 running 更新不会再弹提示。
    expect(toastSpy.success).toHaveBeenCalledTimes(1);
    expect(toastSpy.error).not.toHaveBeenCalled();
  });

  it("dedupes log chunks by sequence and keeps them ordered", async () => {
    const { queryClient } = setup();
    await settle();

    await emitLog(2);
    await emitLog(1);
    await emitLog(2);

    const detail = queryClient.getQueryData<ExecutionTaskDetail>(
      qk.executionTask("t1"),
    );
    expect(detail?.logs.map((log) => log.sequence)).toEqual([1, 2]);
    // 反向断言：序号 2 只保留一份。
    expect(detail?.logs).toHaveLength(2);
    expect(detail?.logs.filter((log) => log.content === "c2")).toHaveLength(1);
  });

  it.each(["failed", "timed_out"] as const)(
    "shows one error toast for a %s task and refreshes only that tool",
    async (status) => {
      const { queryClient } = setup();
      await settle();

      await emitTask({
        ...BASE,
        status,
        finishedAtMs: 2,
        exitCode: 1,
        errorMessage: "boom",
      });
      await settle();

      expect(toastSpy.error).toHaveBeenCalledTimes(1);
      expect(toastSpy.error).toHaveBeenCalledWith("Codex update failed", {
        id: "execution-task-t1",
        description: "boom",
      });
      // 对账标记已清除。
      expect(queryClient.getQueryData(qk.executionReconciliations())).toEqual(
        {},
      );
      const calls = detectCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0].args).toEqual({ toolKey: "codex", force: true });
      // 反向断言：失败终态不弹成功或警告。
      expect(toastSpy.success).not.toHaveBeenCalled();
      expect(toastSpy.warning).not.toHaveBeenCalled();
    },
  );
});

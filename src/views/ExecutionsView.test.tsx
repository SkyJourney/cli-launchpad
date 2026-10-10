// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "react-i18next",
  async () => (await import("../test/host/hostMocks")).reactI18nextMock,
);
vi.mock(
  "sonner",
  async () => (await import("../test/host/hostMocks")).sonnerMock,
);

import type { ExecutionTask, ExecutionTaskDetail } from "../lib/tauri";
import { tauriMock } from "../test/tauriMock";
import { ExecutionsView } from "./ExecutionsView";

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

function renderWithTask(task: ExecutionTask) {
  tauriMock.setInvokeHandler((command) => {
    if (command === "list_execution_tasks") return [task];
    if (command === "get_execution_task") {
      return { task, logs: [] } satisfies ExecutionTaskDetail;
    }
    return undefined;
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ExecutionsView />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  expect(tauriMock.state.eventListeners).toHaveLength(0);
});

describe("ExecutionsView terminal states", () => {
  it.each([
    ["failed", 1],
    ["timed_out", null],
  ] as const)(
    "shows a %s task with the failure style, its error and no cancel action",
    async (status, exitCode) => {
      const task: ExecutionTask = {
        ...BASE,
        status,
        finishedAtMs: 2,
        exitCode,
        errorMessage: "boom",
      };
      renderWithTask(task);

      let labels: HTMLElement[] = [];
      // 列表项立即渲染；详情头要等 get_execution_task 返回，所以等待期望的两个标签都出现。
      await waitFor(() => {
        labels = screen.getAllByText(`executions.status.${status}`);
        expect(labels).toHaveLength(2);
      });
      // 列表项与详情头各一个状态标签。
      expect(labels).toHaveLength(2);
      for (const label of labels) {
        expect(label.closest(".execution-status")?.className).toContain(
          "status-failed",
        );
      }
      const error = screen.getByText("boom");
      expect(error.className).toContain("execution-task-error");
      expect(screen.getByText("executions.clearRecord")).toBeTruthy();
      // 反向断言：终态任务没有取消按钮。
      expect(screen.queryByText("executions.cancelTask")).toBeNull();
      if (exitCode === null) {
        expect(document.body.textContent).not.toContain("executions.exitCode");
      } else {
        expect(document.body.textContent).toContain(
          `executions.exitCode:{"code":${exitCode}}`,
        );
      }
    },
  );
});

// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "react-i18next",
  async () => (await import("./test/host/hostMocks")).reactI18nextMock,
);
vi.mock(
  "sonner",
  async () => (await import("./test/host/hostMocks")).sonnerMock,
);
vi.mock(
  "./components/PtyTerminal",
  async () => (await import("./test/host/hostMocks")).ptyTerminalMock,
);

import { tauriMock } from "./test/tauriMock";
import { resetFakeTerminals } from "./test/host/hostMocks";
import {
  createBackend,
  emitBackendEvent,
  flush,
  invokes,
  mountApp,
} from "./test/host/workspaceHarness";

let host: Awaited<ReturnType<typeof mountApp>> | undefined;
afterEach(async () => {
  host?.dispose();
  host = undefined;
  cleanup();
  resetFakeTerminals();
  vi.useRealTimers();
  await flush();
  expect(tauriMock.state.eventListeners).toHaveLength(0);
  // ACL 拒绝会被宿主吞掉时用例仍可能通过，所以显式断言没有任何权限违规。
  expect(tauriMock.state.aclViolations).toEqual([]);
});

/** 含一个已打开文件 a.txt 的布局；挂载后在编辑器里改内容即得到“脏文件”。 */
const DIRTY_LAYOUT = {
  status: { status: "ready" as const },
  revision: 1,
  schemaVersion: 5,
  slotStates: [],
  updatedAtMs: null,
  layout: {
    schemaVersion: 5,
    tree: {
      kind: "pane" as const,
      id: "p1",
      paneNumber: 1,
      contents: [{ kind: "file" as const, documentId: "d1" }],
      activeContent: { kind: "file" as const, documentId: "d1" },
    },
    focusedPaneId: "p1",
    slots: [],
    documents: [
      {
        id: "d1",
        directoryId: 1,
        directoryPath: "C:/project",
        relativePath: "a.txt",
      },
    ],
    detachedContents: [],
  },
};

async function mountExitApp(options: { dirty: boolean }) {
  host = await mountApp({
    backend: options.dirty
      ? createBackend({ ...DIRTY_LAYOUT })
      : createBackend(),
  });
  await flush(10);
  if (options.dirty) {
    const editor = await screen.findByLabelText("editor");
    fireEvent.change(editor, { target: { value: "dirty" } });
    await flush();
  }
  return host;
}

async function requestExit(
  payload: {
    ptyCount: number;
    executionTaskCount?: number;
  },
  requestId = "req-1",
) {
  await emitBackendEvent("app-exit-requested", { requestId, ...payload });
  await flush(10);
}

async function clickInDialog(name: string) {
  const dialog = screen.getByRole("dialog");
  await act(async () => {
    fireEvent.click(within(dialog).getByText(name));
  });
  await flush();
}

describe("application exit precheck", () => {
  type Row = [
    string,
    string,
    { ptyCount: number; executionTaskCount?: number; dirty: boolean },
    "cancel" | "confirm",
  ];
  const rows: Row[] = [
    ["dirty file only", "cancel", { ptyCount: 0, dirty: true }, "cancel"],
    ["dirty file only", "confirm", { ptyCount: 0, dirty: true }, "confirm"],
    ["running PTY only", "cancel", { ptyCount: 1, dirty: false }, "cancel"],
    ["running PTY only", "confirm", { ptyCount: 1, dirty: false }, "confirm"],
    ["PTY and dirty file", "cancel", { ptyCount: 2, dirty: true }, "cancel"],
    ["PTY and dirty file", "confirm", { ptyCount: 2, dirty: true }, "confirm"],
    [
      "execution tasks only",
      "cancel",
      { ptyCount: 0, executionTaskCount: 2, dirty: false },
      "cancel",
    ],
    [
      "execution tasks only",
      "confirm",
      { ptyCount: 0, executionTaskCount: 2, dirty: false },
      "confirm",
    ],
    [
      "everything at once",
      "confirm",
      { ptyCount: 1, executionTaskCount: 2, dirty: true },
      "confirm",
    ],
  ];

  it.each(rows)("%s: %s", async (_name, _label, state, action) => {
    await mountExitApp({ dirty: state.dirty });

    await requestExit({
      ptyCount: state.ptyCount,
      ...(state.executionTaskCount === undefined
        ? {}
        : { executionTaskCount: state.executionTaskCount }),
    });

    const dialog = screen.getByRole("dialog");
    if (state.ptyCount > 0) {
      expect(dialog.textContent).toContain("appExit.description");
    }
    if (state.dirty) expect(dialog.textContent).toContain("a.txt");
    if ((state.executionTaskCount ?? 0) > 0) {
      expect(dialog.textContent).toContain("appExit.executionTasks");
    }
    // 反向断言：没有对应损失时不出现对应的提示行。
    if ((state.executionTaskCount ?? 0) === 0) {
      expect(dialog.textContent).not.toContain("appExit.executionTasks");
    }
    if (state.ptyCount === 0) {
      expect(dialog.textContent).not.toContain("appExit.description");
    }
    if (!state.dirty) expect(dialog.textContent).not.toContain("a.txt");

    await clickInDialog(
      action === "cancel" ? "common.cancel" : "appExit.confirmDiscard",
    );

    if (action === "cancel") {
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(invokes("confirm_app_exit")).toHaveLength(0);
      if (state.dirty) {
        expect(
          (screen.getByLabelText("editor") as HTMLTextAreaElement).value,
        ).toBe("dirty");
      }
    } else {
      expect(invokes("confirm_app_exit")).toHaveLength(1);
    }
    // 反向断言：退出流程不得终止任何任务或会话（终止是目标 041 的 Rust 侧职责）。
    expect(invokes("cancel_execution_task")).toHaveLength(0);
    expect(invokes("terminate_pty_session")).toHaveLength(0);
    expect(host!.errors).toEqual([]);
  });

  it("exits immediately without a dialog when nothing would be lost", async () => {
    await mountExitApp({ dirty: false });

    await requestExit({ ptyCount: 0 });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(invokes("confirm_app_exit")).toHaveLength(1);
    expect(invokes("terminate_pty_session")).toHaveLength(0);
  });

  it("treats a non-finite executionTaskCount payload as zero tasks", async () => {
    await mountExitApp({ dirty: false });

    // JSON 里的 NaN 会变成 null，其他非数字值也可能出现；都不能卡出一个空对话框。
    await requestExit({
      ptyCount: 0,
      executionTaskCount: "oops" as unknown as number,
    });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(invokes("confirm_app_exit")).toHaveLength(1);
  });

  it("replaces a pending dialog when exit is requested again", async () => {
    await mountExitApp({ dirty: true });

    await requestExit({ ptyCount: 1 });
    await requestExit({ ptyCount: 1 }, "req-2");

    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(invokes("confirm_app_exit")).toHaveLength(0);
    // 反向断言：对话框的文件列表里只有一份 a.txt（编辑器标签页标题里也有 a.txt，所以限定到对话框内）。
    expect(
      within(screen.getByRole("dialog")).getAllByText("a.txt"),
    ).toHaveLength(1);
  });
});

describe("application exit silent failure", () => {
  function rejectConfirmExit(target: NonNullable<typeof host>) {
    target.backend.handlers.set("confirm_app_exit", () => {
      throw {
        code: "pty_sessions_active",
        message: "still running",
        params: { count: 1 },
      };
    });
  }

  it("recovers the dialog when a silent exit is rejected by the backend", async () => {
    await mountExitApp({ dirty: false });
    rejectConfirmExit(host!);

    await requestExit({ ptyCount: 0 });

    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector(".error")?.textContent).toContain(
      "errors.ptySessionsActive",
    );
    const cancel = within(dialog).getByText("common.cancel");
    const confirm = within(dialog).getByText("appExit.confirmDiscard");
    expect((cancel as HTMLButtonElement).disabled).toBe(false);
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    // 反向断言：没有停在“终止中”，且静默路径只调用了一次。
    expect(dialog.textContent).not.toContain("appExit.terminating");
    expect(invokes("confirm_app_exit")).toHaveLength(1);

    await act(async () => {
      fireEvent.click(cancel);
    });
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("re-enables actions when a confirmed exit fails", async () => {
    await mountExitApp({ dirty: true });
    rejectConfirmExit(host!);

    await requestExit({ ptyCount: 0 });
    await clickInDialog("appExit.confirmDiscard");

    const dialog = screen.getByRole("dialog");
    expect(
      (within(dialog).getByText("common.cancel") as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (within(dialog).getByText("appExit.confirmDiscard") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(dialog.querySelector(".error")?.textContent).toContain(
      "errors.ptySessionsActive",
    );
    expect(dialog.textContent).not.toContain("appExit.terminating");
  });
});

describe("application exit requests", () => {
  it("confirms exit with the pending request id", async () => {
    const host = await mountExitApp({ dirty: false });
    await emitBackendEvent("app-exit-requested", {
      requestId: "req-1",
      ptyCount: 0,
      executionTaskCount: 0,
    });
    await flush(10);

    const confirms = invokes("confirm_app_exit");
    expect(confirms).toHaveLength(1);
    expect(confirms[0].args).toEqual({ requestId: "req-1" });
    expect(host.errors).toEqual([]);
    expect(invokes("terminate_pty_session")).toHaveLength(0);
  });

  it("ignores an exit request without a request id", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const host = await mountExitApp({ dirty: false });
    await emitBackendEvent("app-exit-requested", { ptyCount: 0 });
    await flush(10);

    expect(invokes("confirm_app_exit")).toHaveLength(0);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe("app.exit_request_invalid");

    for (const payload of [
      { requestId: "", ptyCount: 0 },
      { requestId: 7, ptyCount: 0 },
      { requestId: "x", ptyCount: "0" },
    ]) {
      await emitBackendEvent("app-exit-requested", payload);
      await flush(10);
    }
    expect(invokes("confirm_app_exit")).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(4);
    expect(invokes("terminate_pty_session")).toHaveLength(0);
    expect(host.errors).toEqual([]);
    warn.mockRestore();
  });

  it("ignores a confirm result for a stale request id", async () => {
    await mountExitApp({ dirty: true });
    await emitBackendEvent("app-exit-requested", {
      requestId: "req-1",
      ptyCount: 0,
      executionTaskCount: 0,
    });
    await flush(10);
    await emitBackendEvent("app-exit-requested", {
      requestId: "req-2",
      ptyCount: 0,
      executionTaskCount: 0,
    });
    await flush(10);

    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    await clickInDialog("appExit.confirmDiscard");

    const confirms = invokes("confirm_app_exit");
    expect(confirms).toHaveLength(1);
    expect(confirms[0].args).toEqual({ requestId: "req-2" });
    expect(
      invokes("confirm_app_exit").some(
        (call) => (call.args as { requestId?: string }).requestId === "req-1",
      ),
    ).toBe(false);
    expect(invokes("terminate_pty_session")).toHaveLength(0);
  });

  it("ignores a superseded request whose impacts resolve after a newer request", async () => {
    // 无脏文件、无 PTY 的 req-1 本会静默退出；它的影响收集晚于 req-2 才完成，必须被丢弃。
    const host = await mountExitApp({ dirty: false });
    // 两次投递放在同一个 act 中：不能用 Promise.all 叠加多个 emitBackendEvent（重叠的 act 会破坏后续渲染）。
    await act(async () => {
      tauriMock.deliverInbox("main", "app-exit-requested", {
        requestId: "req-1",
        ptyCount: 0,
        executionTaskCount: 0,
      });
      tauriMock.deliverInbox("main", "app-exit-requested", {
        requestId: "req-2",
        ptyCount: 1,
        executionTaskCount: 0,
      });
    });
    await flush(10);

    expect(invokes("confirm_app_exit")).toHaveLength(0);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(host.errors).toEqual([]);
    expect(invokes("terminate_pty_session")).toHaveLength(0);
  });
});

describe("application exit requests in flight", () => {
  it("ignores a silent exit failure that belongs to a superseded request", async () => {
    await mountExitApp({ dirty: false });
    // 挂起静默路径的确认，使 req-1 的失败晚于 req-2 到达。
    let rejectSilent: ((error: unknown) => void) | undefined;
    host!.backend.handlers.set(
      "confirm_app_exit",
      () =>
        new Promise((_resolve, reject) => {
          rejectSilent = reject;
        }),
    );
    await requestExit({ ptyCount: 0 }, "req-1");
    await requestExit({ ptyCount: 1 }, "req-2");
    expect(invokes("confirm_app_exit")).toHaveLength(1);
    // 新请求的对话框不继承旧确认的“终止中”：确认按钮可用。
    expect(
      (
        within(screen.getByRole("dialog")).getByText(
          "appExit.confirmDiscard",
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(false);

    await act(async () => {
      rejectSilent?.({
        code: "exit.request_mismatch",
        message: "stale",
      });
    });
    await flush();

    const dialog = screen.getByRole("dialog");
    // 当前对话框仍是 req-2 的内容（ptyCount 1），没有被 req-1 的影响替换。
    expect(dialog.textContent).toContain("appExit.description");
    // 反向断言：过期失败没有显示在新对话框上，按钮已解除“终止中”。
    expect(dialog.querySelector(".error")).toBeNull();
    expect(dialog.textContent).not.toContain("appExit.terminating");
    expect(
      (within(dialog).getByText("appExit.confirmDiscard") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(invokes("terminate_pty_session")).toHaveLength(0);
  });

  it("ignores a confirm failure from the dialog that belongs to a superseded request", async () => {
    await mountExitApp({ dirty: true });
    // 挂起对话框确认，使 req-1 的失败晚于 req-2 到达。
    let rejectConfirm: ((error: unknown) => void) | undefined;
    host!.backend.handlers.set(
      "confirm_app_exit",
      () =>
        new Promise((_resolve, reject) => {
          rejectConfirm = reject;
        }),
    );
    await requestExit({ ptyCount: 0 }, "req-1");
    await clickInDialog("appExit.confirmDiscard");
    expect(invokes("confirm_app_exit")).toHaveLength(1);

    await requestExit({ ptyCount: 1 }, "req-2");
    await act(async () => {
      rejectConfirm?.({
        code: "exit.request_mismatch",
        message: "stale",
      });
    });
    await flush();

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("appExit.description");
    // 反向断言：req-1 的确认失败不显示在 req-2 的对话框上，且 req-2 可以确认。
    expect(dialog.querySelector(".error")).toBeNull();
    expect(
      (within(dialog).getByText("appExit.confirmDiscard") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(
      invokes("confirm_app_exit").map(
        (call) => (call.args as { requestId?: string }).requestId,
      ),
    ).toEqual(["req-1"]);
  });
});

describe("exit dialog impact list", () => {
  it("lists dirty files in the shared list element", async () => {
    const host = await mountExitApp({ dirty: true });
    await requestExit({ ptyCount: 0, executionTaskCount: 0 });

    const dialog = screen.getByRole("dialog");
    const lists = dialog.querySelectorAll("ul.app-exit-unsaved-files");
    expect(lists).toHaveLength(1);
    expect(
      [...lists[0]!.querySelectorAll("li")].map((item) => item.textContent),
    ).toEqual(["a.txt"]);
    expect(dialog.textContent).toContain("appExit.unsavedDescription");
    // 反向：没有确认，也没有错误。
    expect(invokes("confirm_app_exit")).toHaveLength(0);
    expect(host.errors).toEqual([]);
  });
});

describe("save all before exit (m6-108)", () => {
  const SAVED = {
    kind: "saved",
    content: "dirty",
    revision: "r2",
    warning: null,
  };

  it("saves every dirty file and then confirms the exit", async () => {
    await mountExitApp({ dirty: true });
    host!.backend.handlers.set("save_project_text_file", () => SAVED);
    await requestExit({ ptyCount: 0 });

    await clickInDialog("appExit.saveAllAndQuit");

    expect(invokes("save_project_text_file")).toHaveLength(1);
    expect(invokes("confirm_app_exit")).toHaveLength(1);
    expect(host!.errors).toEqual([]);
  });

  it("a failed save keeps the dialog open and never confirms the exit", async () => {
    await mountExitApp({ dirty: true });
    host!.backend.handlers.set("save_project_text_file", () => {
      throw new Error("disk full");
    });
    await requestExit({ ptyCount: 0 });

    await clickInDialog("appExit.saveAllAndQuit");

    expect(invokes("confirm_app_exit")).toHaveLength(0);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("appExit.saveAllAndQuit")).toBeTruthy();
    expect(host!.errors).toEqual([]);
  });
});

describe("exit impacts reported by Rust (m6-101)", () => {
  type ReportFn = (args: {
    requestId: string;
    dirtyFiles: unknown[];
  }) => unknown;

  function setReport(...responses: ReportFn[]) {
    let index = 0;
    host!.backend.handlers.set("report_exit_impacts", (args) => {
      const respond = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return respond(args);
    });
  }

  const view = (
    requestId: string,
    ptyCount: number,
    executionTaskCount: number,
    dirtyFiles: unknown[] = [],
  ) => ({
    requestId,
    ptyCount,
    executionTaskCount,
    dirtyFiles,
    requiresPrompt:
      ptyCount > 0 || executionTaskCount > 0 || dirtyFiles.length > 0,
  });

  it("FX-1 builds the prompt from the Rust report instead of the event payload", async () => {
    await mountExitApp({ dirty: false });
    // The event claims nothing is running; Rust reports one session, so the user must be asked.
    setReport((args) => view(args.requestId, 2, 0));

    await requestExit({ ptyCount: 0, executionTaskCount: 0 }, "r1");

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("appExit.description");
    expect(invokes("confirm_app_exit")).toHaveLength(0);
  });

  it("FX-2 exits silently only when Rust reports no impacts, whatever the event payload claims", async () => {
    await mountExitApp({ dirty: false });
    setReport((args) => view(args.requestId, 0, 0));

    await requestExit({ ptyCount: 5, executionTaskCount: 3 }, "r2");

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(invokes("confirm_app_exit")).toHaveLength(1);
    expect(invokes("confirm_app_exit")[0].args).toEqual({ requestId: "r2" });
  });

  it("FX-2b asks when Rust reports impacts even though the event payload is empty", async () => {
    await mountExitApp({ dirty: false });
    setReport((args) => view(args.requestId, 0, 0));
    setReport((args) => view(args.requestId, 0, 1));

    await requestExit({ ptyCount: 0, executionTaskCount: 0 }, "r2b");

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(invokes("confirm_app_exit")).toHaveLength(0);
  });

  it("FX-4 refreshes the request when the silent exit is rejected with exit.impacts_changed", async () => {
    await mountExitApp({ dirty: false });
    setReport(
      (args) => view(args.requestId, 0, 0),
      (args) => view(args.requestId, 1, 0),
    );
    host!.backend.handlers.set("confirm_app_exit", () => {
      throw { code: "exit.impacts_changed", message: "changed" };
    });

    await requestExit({ ptyCount: 0, executionTaskCount: 0 }, "r4");

    expect(invokes("confirm_app_exit")).toHaveLength(1);
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("appExit.description");
    expect(dialog.querySelector(".error")).toBeNull();
  });

  it("FX-5 asks again with the updated counts when the dialog confirmation finds more running work", async () => {
    await mountExitApp({ dirty: false });
    setReport(
      (args) => view(args.requestId, 1, 0),
      (args) => view(args.requestId, 2, 0),
    );

    await requestExit({ ptyCount: 1, executionTaskCount: 0 }, "r5");
    expect(screen.getByRole("dialog").textContent).toContain(
      "appExit.description",
    );

    await clickInDialog("appExit.confirmDiscard");

    expect(invokes("report_exit_impacts")).toHaveLength(2);
    expect(invokes("confirm_app_exit")).toHaveLength(0);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("FX-6 falls back to the local dialog when the report fails and reports again on confirm", async () => {
    await mountExitApp({ dirty: false });
    setReport(
      () => {
        throw { code: "exit.report_invalid", message: "bad" };
      },
      (args) => view(args.requestId, 1, 0),
    );

    await requestExit({ ptyCount: 1, executionTaskCount: 0 }, "r6");

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("appExit.description");
    expect(dialog.querySelector(".error")).not.toBeNull();
    expect(invokes("confirm_app_exit")).toHaveLength(0);

    await clickInDialog("appExit.confirmDiscard");

    expect(invokes("report_exit_impacts")).toHaveLength(2);
    expect(invokes("confirm_app_exit")).toHaveLength(1);
  });
});

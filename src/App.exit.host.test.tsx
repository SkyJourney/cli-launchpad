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

async function requestExit(payload: {
  ptyCount: number;
  executionTaskCount?: number;
}) {
  await emitBackendEvent("app-exit-requested", payload);
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

  it("replaces a pending dialog when exit is requested again", async () => {
    await mountExitApp({ dirty: true });

    await requestExit({ ptyCount: 1 });
    await requestExit({ ptyCount: 1 });

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

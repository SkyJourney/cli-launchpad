// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "react-i18next",
  async () => (await import("../test/host/hostMocks")).reactI18nextMock,
);
vi.mock(
  "sonner",
  async () => (await import("../test/host/hostMocks")).sonnerMock,
);
vi.mock(
  "./PtyTerminal",
  async () => (await import("../test/host/hostMocks")).ptyTerminalMock,
);

import { tauriMock } from "../test/tauriMock";
import {
  createBackend,
  flush,
  invokes,
  mountWorkspace,
  savedLayouts,
  type WorkspaceHost,
} from "../test/host/workspaceHarness";
import { resetFakeTerminals } from "../test/host/hostMocks";

let host: WorkspaceHost | undefined;
afterEach(async () => {
  host?.dispose();
  host = undefined;
  cleanup();
  resetFakeTerminals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await flush();
  expect(tauriMock.state.eventListeners).toHaveLength(0);
});

/** 结构合法但归属非法：引用了不存在的 slot，读侧必须降级而不是崩溃。 */
const INVALID_LAYOUT = {
  schemaVersion: 5,
  tree: {
    kind: "pane" as const,
    id: "pane-1",
    paneNumber: 1,
    contents: [{ kind: "pty" as const, slotId: "ghost" }],
    activeContent: { kind: "pty" as const, slotId: "ghost" },
  },
  focusedPaneId: "pane-1",
  slots: [],
  documents: [],
  detachedContents: [],
};

describe("PTY workspace snapshot read-side degradation", () => {
  it("does not crash the window when the persisted layout is invalid and recovers on retry", async () => {
    const backend = createBackend({
      status: { status: "ready" },
      revision: 3,
      schemaVersion: 5,
      updatedAtMs: null,
      layout: INVALID_LAYOUT as never,
      slotStates: [],
    });
    host = await mountWorkspace({ backend });
    await flush(10);

    expect(host.ctx().hydrationStatus).toBe("loadFailed");
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("pty.layoutLoadFailed");
    expect(alert.textContent).toContain(
      "PTY content has missing or duplicate ownership",
    );
    // 没有错误冒泡到 ErrorBoundary。
    expect(host.errors).toEqual([]);
    // 反向断言：失败的读取不得写回数据库。
    expect(savedLayouts(host)).toEqual([]);
    expect(invokes("save_workspace_layout")).toHaveLength(0);
    expect(invokes("get_workspace_layout")).toHaveLength(1);

    // 后端修好之后，点击重试恢复到 ready。
    backend.layout = {
      status: { status: "missing" },
      revision: 3,
      schemaVersion: null,
      updatedAtMs: null,
      layout: null,
      slotStates: [],
    };
    fireEvent.click(
      screen.getByRole("button", { name: "pty.retryLayoutRead" }),
    );
    await flush(10);

    expect(host.ctx().hydrationStatus).toBe("ready");
    expect(invokes("get_workspace_layout")).toHaveLength(2);
    expect(host.errors).toEqual([]);
    // 反向断言：非法的 ghost 引用从未被写回。
    expect(JSON.stringify(savedLayouts(host))).not.toContain("ghost");
  });

  it("shows the reset notice instead of crashing when the backend reports a corrupt layout", async () => {
    const backend = createBackend({
      status: { status: "needsReset", reason: "corrupt snapshot" },
      revision: 2,
      schemaVersion: null,
      updatedAtMs: null,
      layout: null,
      slotStates: [],
    });
    backend.handlers.set("reset_workspace_layout", () => 7);
    host = await mountWorkspace({ backend });
    await flush(10);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    expect(host.ctx().hydrationStatus).toBe("needsReset");
    expect(screen.getByText(/pty\.layoutNeedsReset/)).toBeTruthy();
    expect(host.errors).toEqual([]);
    expect(invokes("save_workspace_layout")).toHaveLength(0);

    // 用户取消确认：不得重置。
    fireEvent.click(screen.getByRole("button", { name: "pty.resetLayout" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(invokes("reset_workspace_layout")).toHaveLength(0);
    expect(host.ctx().hydrationStatus).toBe("needsReset");

    // 用户确认之后才调用重置。
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "pty.resetLayout" }));
    await flush(10);

    expect(invokes("reset_workspace_layout")).toHaveLength(1);
    expect(host.ctx().hydrationStatus).toBe("ready");
  });
});

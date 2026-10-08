// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
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
import { resetFakeTerminals } from "../test/host/hostMocks";
import {
  createBackend,
  flush,
  flushUntil,
  invokes,
  mountWorkspace,
  type WorkspaceHost,
} from "../test/host/workspaceHarness";
import { listWorkspacePanes } from "../lib/ptyWorkspaceLayout";
import { createWorkspaceLayoutDocument } from "../lib/workspaceLayoutPersistence";
import type { WorkspaceLayoutDocument } from "../lib/tauri";

let host: WorkspaceHost | undefined;
afterEach(async () => {
  host?.dispose();
  host = undefined;
  cleanup();
  resetFakeTerminals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  await flush();
  expect(tauriMock.state.eventListeners).toHaveLength(0);
  // ACL 拒绝会被宿主吞掉时用例仍可能通过，所以显式断言没有任何权限违规。
  expect(tauriMock.state.aclViolations).toEqual([]);
});

function futureSchemaLayout(): WorkspaceLayoutDocument {
  const document = createWorkspaceLayoutDocument({
    tree: {
      kind: "pane",
      id: "pane-1",
      paneNumber: 1,
      contents: [],
      activeContent: null,
    },
    focusedPaneId: "pane-1",
    slots: [],
    documents: [],
    detachedContents: [],
  });
  return {
    ...document,
    schemaVersion: 6,
  } as unknown as WorkspaceLayoutDocument;
}

describe("hydration failure modes", () => {
  it("shows needsReset and resets on confirmation", async () => {
    const backend = createBackend({
      status: { status: "needsReset", reason: "bad" },
      revision: 6,
    });
    backend.handlers.set("reset_workspace_layout", () => 7);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    host = await mountWorkspace({ backend });

    expect(host.ctx().hydrationStatus).toBe("needsReset");
    expect(invokes("save_workspace_layout")).toHaveLength(0);

    fireEvent.click(screen.getByText("pty.resetLayout"));
    await flushUntil(
      () => host!.ctx().hydrationStatus === "ready",
      "hydration after reset",
    );
    // 重置后进入 ready 会立刻自动保存一次（revision 8 = 重置返回的 7 + 1）。
    await flushUntil(
      () => backend.saved.length >= 1,
      "first autosave after reset",
    );
    const paneId = listWorkspacePanes(host.ctx().tree)[0].id;
    await act(async () => {
      host!.ctx().splitPane(paneId, "horizontal");
    });
    await flushUntil(
      () => backend.saved.length >= 2,
      "autosave after the split",
    );

    // 队列从重置返回的 7 继续：8（进入 ready 的自动保存）、9（拆分后的保存）。
    expect(backend.saved.map((entry) => entry.revision)).toEqual([8, 9]);
    expect(invokes("reset_workspace_layout")).toHaveLength(1);
  });

  it("shows loadFailed with retry when reading fails", async () => {
    const backend = createBackend();
    let reads = 0;
    backend.handlers.set("get_workspace_layout", () => {
      reads += 1;
      if (reads === 1) throw new Error("read failed");
      return backend.layout;
    });

    host = await mountWorkspace({ backend });

    expect(host.ctx().hydrationStatus).toBe("loadFailed");
    expect(invokes("save_workspace_layout")).toHaveLength(0);

    fireEvent.click(screen.getByText("pty.retryLayoutRead"));
    await flushUntil(
      () => host!.ctx().hydrationStatus === "ready",
      "hydration after retry",
    );

    expect(reads).toBe(2);
  });

  it("routes a future schema returned as ready to needsReset instead of loadFailed", async () => {
    const backend = createBackend({
      status: { status: "ready" },
      revision: 3,
      schemaVersion: 6,
      layout: futureSchemaLayout(),
    });

    host = await mountWorkspace({ backend });
    await flush();

    expect(host.ctx().hydrationStatus).toBe("needsReset");
    expect(host.ctx().hydrationStatus).not.toBe("loadFailed");
    expect(invokes("save_workspace_layout")).toHaveLength(0);
  });
});

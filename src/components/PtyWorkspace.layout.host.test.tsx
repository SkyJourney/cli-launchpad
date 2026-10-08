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
import { assertWorkspaceInvariants } from "../test/host/workspaceInvariants";
import {
  DIRECTORY,
  createBackend,
  detachFileToWindow,
  flush,
  flushUntil,
  invokes,
  mountWorkspace,
  openFile,
  savedLayouts,
  type WorkspaceHost,
} from "../test/host/workspaceHarness";
import { listWorkspacePanes } from "../lib/ptyWorkspaceLayout";
import { WorkspaceContentCoordinator } from "../lib/workspaceContentCoordinator";
import {
  WORKSPACE_LAYOUT_SCHEMA_VERSION,
  createWorkspaceLayoutDocument,
} from "../lib/workspaceLayoutPersistence";
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

describe("named layouts with detached contents", () => {
  it("keeps a detached file out of the applied tree and in persisted detached contents", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    const doc = await openFile(host);
    await detachFileToWindow(host, doc.id);
    host.backend.handlers.set("plan_apply_workspace_layout_preset", () => ({
      slotStates: [],
      layout: {
        schemaVersion: WORKSPACE_LAYOUT_SCHEMA_VERSION,
        focusedPaneId: "pa",
        slots: [],
        detachedContents: [],
        documents: [
          {
            id: "preset-doc",
            directoryId: DIRECTORY.id,
            directoryPath: DIRECTORY.path,
            relativePath: "a.txt",
          },
        ],
        tree: {
          kind: "split",
          id: "s1",
          direction: "horizontal",
          ratio: 0.5,
          first: {
            kind: "pane",
            id: "pa",
            paneNumber: 1,
            contents: [{ kind: "file", documentId: "preset-doc" }],
            activeContent: { kind: "file", documentId: "preset-doc" },
          },
          second: {
            kind: "pane",
            id: "pb",
            paneNumber: 2,
            contents: [],
            activeContent: null,
          },
        },
      },
    }));

    await act(async () => {
      await host!.ctx().applyWorkspaceLayoutPreset("preset-1");
    });
    await flush();

    const panes = listWorkspacePanes(host.ctx().tree);
    expect(panes).toHaveLength(2);
    expect(panes.map((pane) => pane.contents)).toEqual([[], []]);
    expect(host.ctx().detachedFileIds.has(doc.id)).toBe(true);
    const saved = savedLayouts(host);
    const lastLayout = saved[saved.length - 1].layout;
    expect(lastLayout.detachedContents).toEqual([
      { kind: "file", documentId: doc.id },
    ]);
    expect(lastLayout.documents).toHaveLength(1);
    expect(lastLayout.documents[0].id).toBe(doc.id);
    expect(() => assertWorkspaceInvariants(host!)).not.toThrow();
    // 反向断言：预设里的文档没有混进持久化文档，应用预设也不销毁任何窗口。
    expect(
      lastLayout.documents.some((document) => document.id === "preset-doc"),
    ).toBe(false);
    expect(
      tauriMock.state.windowActions.some((entry) => entry.action === "destroy"),
    ).toBe(false);
    expect(host.errors).toEqual([]);
  });

  it("rehomes persisted detached files into the focused pane on startup", async () => {
    const backend = createBackend({
      status: { status: "ready" },
      revision: 3,
      schemaVersion: WORKSPACE_LAYOUT_SCHEMA_VERSION,
      layout: {
        schemaVersion: WORKSPACE_LAYOUT_SCHEMA_VERSION,
        tree: {
          kind: "pane",
          id: "pane-1",
          paneNumber: 1,
          contents: [],
          activeContent: null,
        },
        focusedPaneId: "pane-1",
        slots: [],
        documents: [
          {
            id: "doc-1",
            directoryId: DIRECTORY.id,
            directoryPath: DIRECTORY.path,
            relativePath: "a.txt",
          },
        ],
        detachedContents: [{ kind: "file", documentId: "doc-1" }],
      },
    });
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ backend, coordinator });
    await flush();

    const pane = listWorkspacePanes(host.ctx().tree).find(
      (candidate) => candidate.id === "pane-1",
    );
    expect(pane?.contents).toEqual([{ kind: "file", documentId: "doc-1" }]);
    const saved = savedLayouts(host);
    expect(saved[0].revision).toBe(4);
    expect(saved[0].layout.detachedContents).toEqual([]);
    expect(coordinator.get({ kind: "file", documentId: "doc-1" })?.phase).toBe(
      "attached",
    );
    expect(() => assertWorkspaceInvariants(host!)).not.toThrow();
    // 反向断言：重启 hydration 只放回树，不创建任何窗口。
    expect(tauriMock.state.createdWindows).toHaveLength(0);
    expect(host.errors).toEqual([]);
  });
});

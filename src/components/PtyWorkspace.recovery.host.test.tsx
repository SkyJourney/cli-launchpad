// @vitest-environment jsdom
import { cleanup } from "@testing-library/react";
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
  detachFileToWindow,
  emitBackendEvent,
  emitToMain,
  flush,
  invokes,
  mountWorkspace,
  openFile,
  savedLayouts,
  type WorkspaceHost,
} from "../test/host/workspaceHarness";
import { listWorkspacePanes } from "../lib/ptyWorkspaceLayout";
import { WorkspaceContentCoordinator } from "../lib/workspaceContentCoordinator";

let host: WorkspaceHost | undefined;
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

const LOST_EVENT = "workspace-content-window-lost";

function fileOccurrences(target: WorkspaceHost, documentId: string) {
  return listWorkspacePanes(target.ctx().tree)
    .flatMap((pane) => pane.contents)
    .filter(
      (content) => content.kind === "file" && content.documentId === documentId,
    ).length;
}

/** 文件分离到独立窗，并让窗口把一份尚未保存的编辑镜像回主窗口。 */
async function detachWithMirroredEdit(target: WorkspaceHost, path = "a.txt") {
  const doc = await openFile(target, path);
  const detached = await detachFileToWindow(target, doc.id);
  await emitToMain("workspace-file-window-buffer-changed", {
    documentId: doc.id,
    token: detached.token,
    windowLabel: detached.windowLabel,
    fileDocument: doc,
    fileBuffer: {
      ...detached.initBuffer,
      content: "mirror",
      version: detached.initBuffer.version + 1,
    },
  });
  await flush();
  return { doc, ...detached };
}

describe("detached window loss", () => {
  it("rehomes a file whose standalone window was destroyed and keeps its mirrored buffer dirty", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    const { doc, windowLabel } = await detachWithMirroredEdit(host);
    const paneId = listWorkspacePanes(host.ctx().tree)[0].id;
    const openCallsBefore = invokes("open_project_file").length;
    const savesBefore = savedLayouts(host).length;

    tauriMock.destroyWindow(windowLabel);
    await emitBackendEvent(LOST_EVENT, { windowLabel });
    await flush();

    const focusedPane = listWorkspacePanes(host.ctx().tree)[0];
    expect(focusedPane.contents).toContainEqual({
      kind: "file",
      documentId: doc.id,
    });
    expect(host.ctx().detachedFileIds.has(doc.id)).toBe(false);
    const buffer = host.ctx().fileBuffers[doc.id];
    expect(buffer.content).toBe("mirror");
    expect(buffer.content).not.toBe(buffer.savedContent);
    expect(savedLayouts(host).length).toBeGreaterThan(savesBefore);
    expect(
      savedLayouts(host)[savedLayouts(host).length - 1].layout.detachedContents,
    ).toEqual([]);
    expect(coordinator.get({ kind: "file", documentId: doc.id })).toMatchObject(
      {
        phase: "attached",
        owner: { kind: "pane", windowLabel: "main", paneId },
      },
    );
    expect(() => assertWorkspaceInvariants(host!)).not.toThrow();
    // 反向断言：回收不重新读盘，也不是一次“正常返回”。
    expect(invokes("open_project_file").length).toBe(openCallsBefore);
    expect(
      tauriMock.state.emittedEvents.some(
        (event) =>
          (event.payload as { type?: string }).type ===
          "workspace-file-window-return-complete",
      ),
    ).toBe(false);
    expect(host.errors).toEqual([]);
  });

  it("ignores a lost event for a window that already returned its file", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    const doc = await openFile(host);
    const pane = listWorkspacePanes(host.ctx().tree)[0];
    const { token, windowLabel, initBuffer } = await detachFileToWindow(
      host,
      doc.id,
    );
    await emitToMain("workspace-file-window-return-requested", {
      documentId: doc.id,
      token,
      windowLabel,
      targetPaneId: pane.id,
      fileDocument: doc,
      fileBuffer: {
        ...initBuffer,
        content: "edited in window",
        version: initBuffer.version + 1,
      },
    });
    await flush(10);
    // 前置状态：返回已经完成（文件在树中恰好 1 次且已回到 attached），再去触发窗口销毁。
    expect(fileOccurrences(host, doc.id)).toBe(1);
    expect(coordinator.get({ kind: "file", documentId: doc.id })?.phase).toBe(
      "attached",
    );
    const treeBefore = host.ctx().tree;
    const savesBefore = savedLayouts(host).length;
    const bufferBefore = host.ctx().fileBuffers[doc.id];

    tauriMock.destroyWindow(windowLabel);
    await emitBackendEvent(LOST_EVENT, { windowLabel });
    await flush(10);

    // 同一引用：没有树提交。
    expect(host.ctx().tree).toBe(treeBefore);
    expect(fileOccurrences(host, doc.id)).toBe(1);
    expect(coordinator.get({ kind: "file", documentId: doc.id })?.phase).toBe(
      "attached",
    );
    expect(savedLayouts(host).length).toBe(savesBefore);
    expect(host.ctx().fileBuffers[doc.id]).toBe(bufferBefore);
    expect(() => assertWorkspaceInvariants(host!)).not.toThrow();
    expect(host.errors).toEqual([]);
  });

  it("ignores a lost event for an unrelated window label", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    const doc = await openFile(host);
    const { windowLabel } = await detachFileToWindow(host, doc.id);
    await flush(10);
    const treeBefore = host.ctx().tree;
    const savesBefore = savedLayouts(host).length;

    for (const unrelated of [
      "workspace-content-00000000-0000-4000-8000-000000000000",
      "terminal-00000000-0000-4000-8000-000000000000",
      "main",
    ]) {
      await emitBackendEvent(LOST_EVENT, { windowLabel: unrelated });
      await flush(5);
    }

    expect(host.ctx().tree).toBe(treeBefore);
    expect(coordinator.get({ kind: "file", documentId: doc.id })).toMatchObject(
      {
        phase: "detached",
        owner: { kind: "window", windowLabel },
      },
    );
    expect(host.ctx().detachedFileIds.has(doc.id)).toBe(true);
    expect(savedLayouts(host).length).toBe(savesBefore);
    expect(() => assertWorkspaceInvariants(host!)).not.toThrow();
    // 反向断言：回收是被动的，不会再销毁任何窗口。
    expect(
      tauriMock.state.windowActions.some((entry) => entry.action === "destroy"),
    ).toBe(false);
    expect(host.errors).toEqual([]);
  });

  it("handles a duplicate lost event once", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    const { doc, windowLabel } = await detachWithMirroredEdit(host);

    tauriMock.destroyWindow(windowLabel);
    await emitBackendEvent(LOST_EVENT, { windowLabel });
    await flush(5);
    const savesAfterFirst = savedLayouts(host).length;
    await emitBackendEvent(LOST_EVENT, { windowLabel });
    await flush(5);

    expect(fileOccurrences(host, doc.id)).toBe(1);
    expect(savedLayouts(host).length).toBe(savesAfterFirst);
    expect(() => assertWorkspaceInvariants(host!)).not.toThrow();
    expect(host.errors).toEqual([]);
  });
});

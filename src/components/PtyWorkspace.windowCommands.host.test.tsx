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
  detachPtyToWindow,
  emitBackendEvent,
  flush,
  invokes,
  launchPty,
  mountWorkspace,
  openFile,
  type WorkspaceHost,
} from "../test/host/workspaceHarness";
import { listWorkspacePanes } from "../lib/ptyWorkspaceLayout";
import { WorkspaceContentCoordinator } from "../lib/workspaceContentCoordinator";
import { useAppStore } from "../store/appStore";

// m6-096 表征测试：窗口类命令（分离、返回、收回）在迁入执行器前后都必须给出同样的可观察结果。
// CHW-1 至 CHW-5 在改动前即通过（表征）；它们是步骤 3 至 6 的行为基线，不得为了迁移而修改断言。

let host: WorkspaceHost | undefined;

/** 最近一次持久化的布局（项目的 lib 目标不含 Array.prototype.at）。 */
const savedLayoutOf = (h: WorkspaceHost) =>
  h.backend.saved[h.backend.saved.length - 1];

afterEach(() => {
  host?.dispose();
  host = undefined;
  resetFakeTerminals();
  cleanup();
});

describe("window commands host behaviour", () => {
  it("CHW-1 detaching a PTY removes it from the pane tree and records it as detached", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    const { slot } = await launchPty(host);
    const focusBefore = host.ctx().focusedPaneId;
    const { windowLabel } = await detachPtyToWindow(host, slot.instanceId);
    await flush(10);

    const ptyRef = { kind: "pty" as const, slotId: slot.instanceId };
    for (const pane of listWorkspacePanes(host.ctx().tree)) {
      expect(pane.contents).not.toContainEqual(ptyRef);
    }
    expect(coordinator.get(ptyRef)).toMatchObject({
      phase: "detached",
      owner: { kind: "window", windowLabel },
    });
    expect(host.ctx().focusedPaneId).toBe(focusBefore);
    expect(host.ctx().detachedInstanceIds.has(slot.instanceId)).toBe(true);
    const lastSaved = savedLayoutOf(host);
    expect(lastSaved?.layout.detachedContents).toContainEqual(ptyRef);
    expect(() => assertWorkspaceInvariants(host!)).not.toThrow();
    expect(host.errors).toEqual([]);
    expect(tauriMock.state.windowActions).not.toContainEqual(
      expect.objectContaining({ windowLabel, action: "destroy" }),
    );
  });

  it("CHW-2 detaching a file removes it from the pane tree, grants the window and records it as detached", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    const doc = await openFile(host, "a.txt");
    const { windowLabel } = await detachFileToWindow(host, doc.id);
    await flush(10);

    const fileRef = { kind: "file" as const, documentId: doc.id };
    for (const pane of listWorkspacePanes(host.ctx().tree)) {
      expect(pane.contents).not.toContainEqual(fileRef);
    }
    expect(coordinator.get(fileRef)).toMatchObject({
      phase: "detached",
      owner: { kind: "window", windowLabel },
    });
    expect(host.ctx().detachedFileIds.has(doc.id)).toBe(true);
    const grants = invokes("grant_content_window_file");
    expect(grants).toHaveLength(1);
    expect(grants[0].args).toMatchObject({ targetLabel: windowLabel });
    const lastSaved = savedLayoutOf(host);
    expect(lastSaved?.layout.detachedContents).toContainEqual(fileRef);
    expect(() => assertWorkspaceInvariants(host!)).not.toThrow();
    expect(invokes("revoke_content_window_file")).toHaveLength(0);
    expect(host.errors).toEqual([]);
  });

  it("CHW-3 a rejected PTY detach ownership commit leaves the PTY in its pane and destroys the new window", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    const { slot } = await launchPty(host);
    const original = coordinator.completeHandoff.bind(coordinator);
    vi.spyOn(coordinator, "completeHandoff").mockImplementation(((
      content: unknown,
      type: string,
      id: string,
      ...rest: unknown[]
    ) =>
      type === "detachReady"
        ? {
            outcome: "ignored",
            state: coordinator.get(content as never)!,
          }
        : (original as (...args: unknown[]) => unknown)(
            content,
            type,
            id,
            ...rest,
          )) as never);
    const treeBefore = host.ctx().tree;
    const { windowLabel } = await detachPtyToWindow(host, slot.instanceId);
    await flush(10);

    const ptyRef = { kind: "pty" as const, slotId: slot.instanceId };
    const holders = listWorkspacePanes(host.ctx().tree).filter((pane) =>
      pane.contents.some(
        (item) => item.kind === "pty" && item.slotId === slot.instanceId,
      ),
    );
    expect(holders).toHaveLength(1);
    expect(host.ctx().tree).toBe(treeBefore);
    expect(host.ctx().detachedInstanceIds.has(slot.instanceId)).toBe(false);
    expect(tauriMock.state.windowActions).toContainEqual(
      expect.objectContaining({ windowLabel, action: "destroy" }),
    );
    expect(() => assertWorkspaceInvariants(host!)).not.toThrow();
    expect(host.errors).toEqual([]);
    const lastSaved = savedLayoutOf(host);
    expect(lastSaved?.layout.detachedContents).not.toContainEqual(ptyRef);
  });

  it("CHW-4 a rejected file detach ownership commit leaves the file in its pane and destroys the new window", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    const doc = await openFile(host, "a.txt");
    const original = coordinator.completeHandoff.bind(coordinator);
    vi.spyOn(coordinator, "completeHandoff").mockImplementation(((
      content: unknown,
      type: string,
      id: string,
      ...rest: unknown[]
    ) =>
      type === "detachReady"
        ? {
            outcome: "ignored",
            state: coordinator.get(content as never)!,
          }
        : (original as (...args: unknown[]) => unknown)(
            content,
            type,
            id,
            ...rest,
          )) as never);
    const { windowLabel } = await detachFileToWindow(host, doc.id);
    await flush(10);

    const fileRef = { kind: "file" as const, documentId: doc.id };
    const holders = listWorkspacePanes(host.ctx().tree).filter((pane) =>
      pane.contents.some(
        (item) => item.kind === "file" && item.documentId === doc.id,
      ),
    );
    expect(holders).toHaveLength(1);
    expect(host.ctx().detachedFileIds.has(doc.id)).toBe(false);
    expect(tauriMock.state.windowActions).toContainEqual(
      expect.objectContaining({ windowLabel, action: "destroy" }),
    );
    expect(() => assertWorkspaceInvariants(host!)).not.toThrow();
    expect(host.errors).toEqual([]);
    // 失败路径撤销授权的次数取自 HEAD 实测（改动前运行得 1 次），迁移后不得改变。
    expect(invokes("revoke_content_window_file")).toHaveLength(1);
    const lastSaved = savedLayoutOf(host);
    expect(lastSaved?.layout.detachedContents).not.toContainEqual(fileRef);
  });

  it("CHW-5 reclaiming a PTY after its window was lost puts it back into the focused pane and opens its project", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    const { slot } = await launchPty(host);
    const { windowLabel } = await detachPtyToWindow(host, slot.instanceId);
    await emitBackendEvent("pty-session-owner-lost", {
      sessionId: slot.sessionId,
    });
    await flush(10);

    const holders = listWorkspacePanes(host.ctx().tree).filter((pane) =>
      pane.contents.some(
        (item) => item.kind === "pty" && item.slotId === slot.instanceId,
      ),
    );
    expect(holders).toHaveLength(1);
    expect(holders[0].id).toBe(host.ctx().focusedPaneId);
    expect(
      coordinator.get({ kind: "pty", slotId: slot.instanceId }),
    ).toMatchObject({
      phase: "attached",
      owner: { kind: "pane", windowLabel: "main" },
    });
    expect(useAppStore.getState().selectedDirectoryId).toBe(slot.directoryId);
    expect(tauriMock.state.windowActions).toContainEqual(
      expect.objectContaining({ windowLabel, action: "destroy" }),
    );
    expect(host.ctx().detachedInstanceIds.has(slot.instanceId)).toBe(false);
    expect(() => assertWorkspaceInvariants(host!)).not.toThrow();
    expect(host.errors).toEqual([]);
  });

  // F4（m6-096 裁定）：返回途中窗口崩溃，lost 事件以前只处理 detached，返回中的文件被忽略而无人回收。
  it("F4 a file whose window is lost while it is returning is reclaimed into a pane", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    const doc = await openFile(host, "a.txt");
    const { windowLabel } = await detachFileToWindow(host, doc.id);
    await flush(10);

    const fileRef = { kind: "file" as const, documentId: doc.id };
    coordinator.beginReturn(
      fileRef,
      "return-f4",
      "main",
      host.ctx().focusedPaneId,
    );
    expect(coordinator.get(fileRef)?.phase).toBe("returning");

    tauriMock.destroyWindow(windowLabel);
    await emitBackendEvent("workspace-content-window-lost", { windowLabel });
    await flush(10);

    const holders = listWorkspacePanes(host.ctx().tree).filter((pane) =>
      pane.contents.some(
        (item) => item.kind === "file" && item.documentId === doc.id,
      ),
    );
    expect(holders).toHaveLength(1);
    expect(coordinator.get(fileRef)).toMatchObject({ phase: "attached" });
    expect(host.ctx().detachedFileIds.has(doc.id)).toBe(false);
    expect(host.errors).toEqual([]);
  });
});

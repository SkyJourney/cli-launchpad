// @vitest-environment jsdom
import { act, cleanup } from "@testing-library/react";
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

import { resetFakeTerminals } from "../test/host/hostMocks";
import { tauriMock } from "../test/tauriMock";
import { assertWorkspaceInvariants } from "../test/host/workspaceInvariants";
import {
  detachFileToWindow,
  emitBackendEvent,
  emitToMain,
  flush,
  invokes,
  mountWorkspace,
  openFile,
  type WorkspaceHost,
} from "../test/host/workspaceHarness";
import { listWorkspacePanes } from "../lib/ptyWorkspaceLayout";
import { WorkspaceContentCoordinator } from "../lib/workspaceContentCoordinator";
import { useAppStore } from "../store/appStore";

let host: WorkspaceHost | undefined;
afterEach(async () => {
  host?.dispose();
  host = undefined;
  cleanup();
  resetFakeTerminals();
  vi.useRealTimers();
  await flush();
  expect(tauriMock.state.eventListeners).toHaveLength(0);
});

async function mountRestoreHost() {
  const coordinator = new WorkspaceContentCoordinator();
  host = await mountWorkspace({ coordinator, restoreListener: true });
  return { coordinator, host };
}

/** 模拟数据库已被恢复：布局为只含一个空 pane 的版本 2。 */
function restoredBackendLayout() {
  return {
    status: { status: "ready" as const },
    revision: 2,
    schemaVersion: 5,
    layout: {
      schemaVersion: 5,
      tree: {
        kind: "pane" as const,
        id: "pane-restored",
        paneNumber: 1,
        contents: [],
        activeContent: null,
      },
      focusedPaneId: "pane-restored",
      slots: [],
      documents: [],
      detachedContents: [],
    },
  };
}

describe("backup restore coordination", () => {
  it.each(["running PTY", "dirty file", "detached window"] as const)(
    "reports blockers for running PTYs, dirty files and detached windows (%s)",
    async (row) => {
      const { host: wsHost } = await mountRestoreHost();
      if (row === "running PTY") {
        useAppStore.getState().upsertPtySession({
          sessionId: "s-run",
          directoryId: 1,
          toolKey: "claude",
          workingDirectory: "C:/project",
          state: "running",
          startedAtMs: 1,
          endedAtMs: null,
          exitCode: null,
        });
        await flush();
        const blockers = await wsHost.ctx().getBackupRestoreBlockers();
        expect(blockers).toEqual({
          runningPtyCount: 1,
          dirtyFileCount: 0,
          detachedWindowCount: 0,
        });
      } else if (row === "dirty file") {
        const doc = await openFile(wsHost);
        await act(async () => {
          wsHost.ctx().editFile(doc.id, "edited");
        });
        await flush();
        const blockers = await wsHost.ctx().getBackupRestoreBlockers();
        expect(blockers).toEqual({
          runningPtyCount: 0,
          dirtyFileCount: 1,
          detachedWindowCount: 0,
        });
        // 守卫已解除：编辑再次生效。
        await act(async () => {
          wsHost.ctx().editFile(doc.id, "after blockers");
        });
        await flush();
        expect(wsHost.ctx().fileBuffers[doc.id]?.content).toBe(
          "after blockers",
        );
      } else {
        const doc = await openFile(wsHost);
        const { token, windowLabel, initBuffer } = await detachFileToWindow(
          wsHost,
          doc.id,
        );
        // 分离窗口会回复 flush 请求（与 exit 宿主测试一致）：回复当前缓冲，因此不计为脏文件。
        const blockersPromise = wsHost.ctx().getBackupRestoreBlockers();
        await flush();
        const request = tauriMock.state.emittedEvents.find(
          (event) =>
            event.target === windowLabel &&
            (event.payload as { type?: string }).type ===
              "workspace-file-window-flush-requested",
        );
        expect(request).toBeDefined();
        const requestId = (
          request!.payload as { payload: { requestId: string } }
        ).payload.requestId;
        await emitToMain("workspace-file-window-flush-complete", {
          documentId: doc.id,
          token,
          windowLabel,
          requestId,
          fileDocument: doc,
          fileBuffer: initBuffer,
        });
        const blockers = await blockersPromise;
        expect(blockers).toEqual({
          runningPtyCount: 0,
          dirtyFileCount: 0,
          detachedWindowCount: 1,
        });
        // 守卫已解除：启动会话再次生效。
        const slotsBefore = wsHost.ctx().slots.length;
        await act(async () => {
          wsHost.ctx().launchSession(1, "claude");
        });
        await flush();
        expect(wsHost.ctx().slots.length).toBe(slotsBefore + 1);
      }
      expect(wsHost.errors).toEqual([]);
    },
  );

  it("blocks edits and launches while a restore is being confirmed", async () => {
    const { host: wsHost } = await mountRestoreHost();
    const doc = await openFile(wsHost);
    const before = wsHost.ctx().fileBuffers[doc.id];
    const slotsBefore = wsHost.ctx().slots.length;

    // 无阻断（工作区干净、无运行中 PTY）时进入冻结。
    const blockers = await wsHost.ctx().getBackupRestoreBlockers();
    expect(blockers).toEqual({
      runningPtyCount: 0,
      dirtyFileCount: 0,
      detachedWindowCount: 0,
    });
    await act(async () => {
      wsHost.ctx().editFile(doc.id, "blocked edit");
      wsHost.ctx().launchSession(1, "claude");
    });
    await flush();

    expect(wsHost.ctx().fileBuffers[doc.id]).toBe(before);
    expect(wsHost.ctx().slots.length).toBe(slotsBefore);
    expect(wsHost.errors).toEqual([]);
  });

  it("does not persist the pre-restore layout between restore success and the restored event", async () => {
    const { host: wsHost } = await mountRestoreHost();
    await wsHost.ctx().getBackupRestoreBlockers();
    Object.assign(wsHost.backend.layout, restoredBackendLayout());
    wsHost.backend.saved.length = 0;

    // 挂载时已有一次布局保存（revision 1）：断言只看此后的增量。
    const savesBefore = invokes("save_workspace_layout").length;
    // 恢复成功后、事件到达前：设置页调用 cancelBackupRestore（onSuccess 的路径）。
    await act(async () => {
      wsHost.ctx().cancelBackupRestore();
    });
    const paneId = listWorkspacePanes(wsHost.ctx().tree)[0].id;
    await act(async () => {
      wsHost.ctx().splitPane(paneId, "horizontal");
    });
    await flush();

    // 断言 A：冻结仍在，恢复事件到达前不得持久化。
    expect(wsHost.backend.saved.length).toBe(0);
    expect(invokes("save_workspace_layout")).toHaveLength(savesBefore);

    await emitBackendEvent("workspace-data-restored", {});
    await flush(10);

    // 断言 B：界面已切换到恢复后的布局。
    const panes = listWorkspacePanes(wsHost.ctx().tree);
    expect(panes).toHaveLength(1);
    expect(panes[0].id).toBe("pane-restored");
    expect(panes[0].contents).toEqual([]);
    expect(() => assertWorkspaceInvariants(wsHost)).not.toThrow();
    expect(wsHost.errors).toEqual([]);
  });

  it("rehydrates to the restored revision and continues saving above it", async () => {
    const { host: wsHost } = await mountRestoreHost();
    await wsHost.ctx().getBackupRestoreBlockers();
    Object.assign(wsHost.backend.layout, restoredBackendLayout());
    wsHost.backend.saved.length = 0;
    await act(async () => {
      wsHost.ctx().cancelBackupRestore();
    });
    await emitBackendEvent("workspace-data-restored", {});
    await flush(10);

    const paneId = listWorkspacePanes(wsHost.ctx().tree)[0].id;
    await act(async () => {
      wsHost.ctx().splitPane(paneId, "horizontal");
    });
    await flush();

    // 恢复后的保存严格位于恢复版本（2）之上：rehydrate 先按恢复后的布局保存一次（3），随后的拆分保存为 4。
    expect(wsHost.backend.saved.map((entry) => entry.revision)).toEqual([3, 4]);
    expect(() => assertWorkspaceInvariants(wsHost)).not.toThrow();
    // 反向断言：没有低于或等于恢复版本的保存。
    expect(wsHost.backend.saved.some((entry) => entry.revision <= 2)).toBe(
      false,
    );
    expect(wsHost.errors).toEqual([]);
  });

  it("resumes persisting after a failed restore once the workspace rehydrates", async () => {
    const { host: wsHost } = await mountRestoreHost();
    await wsHost.ctx().getBackupRestoreBlockers();
    wsHost.backend.saved.length = 0;

    // 失败回调的第一步：只 cancel，仍然冻结。
    await act(async () => {
      wsHost.ctx().cancelBackupRestore();
    });
    const paneId = listWorkspacePanes(wsHost.ctx().tree)[0].id;
    await act(async () => {
      wsHost.ctx().splitPane(paneId, "horizontal");
    });
    await flush();
    // 反向断言：cancel 之后、rehydrate 之前，仍不保存。
    expect(wsHost.backend.saved.length).toBe(0);

    // 失败回调的第二步：rehydrate 解冻。
    await act(async () => {
      await wsHost.ctx().rehydrateWorkspace();
    });
    await flush(10);
    // rehydrate 的 ready 效应会保存一次：以此为基线，只断言之后的拆分确实保存。
    const savedAfterRehydrate = wsHost.backend.saved.length;
    const nowPaneId = listWorkspacePanes(wsHost.ctx().tree)[0].id;
    await act(async () => {
      wsHost.ctx().splitPane(nowPaneId, "horizontal");
    });
    await flush();

    expect(wsHost.backend.saved.length).toBeGreaterThan(savedAfterRehydrate);
    expect(() => assertWorkspaceInvariants(wsHost)).not.toThrow();
    expect(wsHost.errors).toEqual([]);
  });
});

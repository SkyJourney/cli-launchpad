// @vitest-environment jsdom
import type { TFunction } from "i18next";
import { afterEach, describe, expect, it, vi } from "vitest";

import { addWorkspaceFileToPane } from "../../lib/ptyWorkspaceLayout";
import { registerPendingWorkspaceContentWindow } from "../../lib/workspaceContentWindowRegistry";
import { initialPendingStage } from "../../lib/workspaceContentPendingStage";
import { fileContentKey, ptyContentKey } from "../../lib/workspaceContentKey";
import { WorkspaceContentCoordinator } from "../../lib/workspaceContentCoordinator";
import { createWorkspaceFileBuffer } from "../../lib/workspaceFileBuffer";
import {
  createInitialHostSnapshot,
  WorkspaceHostStore,
} from "../host/workspaceHostStore";
import {
  createContentWindowOrchestrator,
  type ContentWindowDeps,
  type ContentWindowPorts,
} from "./contentWindowOrchestrator";

const LABEL = "terminal-8e783338-f464-4b10-b15e-b534748c6241";
const FILE_LABEL = "workspace-content-8e783338-f464-4b10-b15e-b534748c6241";
const OTHER_LABEL = "terminal-11111111-1111-4111-8111-111111111111";
const SOURCE = { kind: "pane", windowLabel: "main", paneId: "pane-1" } as const;
const DOC = {
  id: "doc-1",
  directoryId: 1,
  directoryPath: "C:/project",
  relativePath: "a.txt",
};
const BUFFER = createWorkspaceFileBuffer({
  kind: "text",
  content: "hello",
  revision: "r1",
});

afterEach(() => {
  vi.useRealTimers();
});

function fakeWindow() {
  return {
    destroy: vi.fn(async () => undefined),
    once: vi.fn(async () => () => undefined),
  };
}

function makeFixture(options: { withFile?: boolean } = {}) {
  const store = new WorkspaceHostStore(createInitialHostSnapshot("pane-1"));
  const coordinator = new WorkspaceContentCoordinator();
  const translate = ((key: string) => key) as unknown as TFunction;
  if (options.withFile) {
    store.commit(
      (live) => ({
        ...live,
        tree: addWorkspaceFileToPane(live.tree, "pane-1", "doc-1"),
        documents: [DOC],
        buffers: { "doc-1": BUFFER },
        hydrationStatus: "ready",
      }),
      "test:setup",
    );
  }
  const child = fakeWindow();
  const ports = {
    createWindow: vi.fn((_options: { label: string }) => child),
    getWindowByLabel: vi.fn(async () => null),
    getPtySessionWindowStatus: vi.fn(async () => "running"),
    grantFile: vi.fn(async () => undefined),
    revokeFile: vi.fn(async (_label: string) => undefined),
    emit: vi.fn(async () => undefined),
  };
  const deps: ContentWindowDeps = {
    store,
    getCoordinator: () => coordinator,
    translate,
    commitTree: (next) =>
      store.commit((live) => ({ ...live, tree: next }), "test:commitTree"),
    setFocusedPane: (paneId) =>
      store.commit(
        (live) => ({ ...live, focusedPaneId: paneId }),
        "test:focus",
      ),
    removeSlot: vi.fn(),
    loadFile: vi.fn(async () => undefined),
    waitForFileSave: vi.fn(async () => undefined),
    terminalOf: () => undefined,
    titleOfPty: () => "title",
    openDirectory: vi.fn(),
    ports: ports as unknown as Partial<ContentWindowPorts>,
  };
  return {
    orchestrator: createContentWindowOrchestrator(deps),
    store,
    coordinator,
    ports,
    deps,
    child,
  };
}

type Fixture = ReturnType<typeof makeFixture>;

/** 登记一个已经 detach 完成的内容：协调器阶段为 detached，窗口 label 与 token 已绑定。 */
function makeDetached(
  f: Fixture,
  ref: { kind: "pty"; slotId: string } | { kind: "file"; documentId: string },
  windowLabel: string,
  token: string,
) {
  f.coordinator.ensureAttached(ref, SOURCE);
  f.coordinator.beginDetach(
    ref,
    SOURCE,
    { kind: "window", windowLabel },
    token,
  );
  f.coordinator.completeHandoff(ref, "detachReady", token);
}

describe("contentWindowOrchestrator", () => {
  it("isManagedDetachedDrag follows the detached phase and the owner window label", () => {
    const f = makeFixture();
    makeDetached(f, { kind: "pty", slotId: "s1" }, LABEL, "tok-1");

    expect(f.orchestrator.isManagedDetachedDrag("s1", LABEL)).toBe(true);
    expect(f.orchestrator.isManagedDetachedDrag("s1", OTHER_LABEL)).toBe(false);
    // 与 HEAD 语义一致：句柄表的内容不参与判定（见 m6-092 偏离记录）。
    f.orchestrator.state.handles.pty.set(
      ptyContentKey("s1"),
      fakeWindow() as never,
    );
    expect(f.orchestrator.isManagedDetachedDrag("s1", LABEL)).toBe(true);
    f.orchestrator.state.handles.pty.delete(ptyContentKey("s1"));
    expect(f.orchestrator.isManagedDetachedDrag("s1", LABEL)).toBe(true);

    f.coordinator.ensureAttached({ kind: "pty", slotId: "s2" }, SOURCE);
    expect(f.orchestrator.isManagedDetachedDrag("s2", LABEL)).toBe(false);
  });

  it("isManagedDetachedFileDrag follows the detached phase and the owner window label", () => {
    const f = makeFixture({ withFile: true });
    makeDetached(f, { kind: "file", documentId: "doc-1" }, FILE_LABEL, "tok-2");

    expect(f.orchestrator.isManagedDetachedFileDrag("doc-1", FILE_LABEL)).toBe(
      true,
    );
    expect(f.orchestrator.isManagedDetachedFileDrag("doc-1", OTHER_LABEL)).toBe(
      false,
    );
    expect(
      f.orchestrator.isManagedDetachedFileDrag("doc-other", FILE_LABEL),
    ).toBe(false);
  });

  it("rollbackPending fails the handoff, rejects the pending promise and destroys the window", () => {
    const f = makeFixture({ withFile: true });
    vi.useFakeTimers();
    const ref = { kind: "file", documentId: "doc-1" } as const;
    f.coordinator.ensureAttached(ref, SOURCE);
    f.coordinator.beginDetach(
      ref,
      SOURCE,
      { kind: "window", windowLabel: FILE_LABEL },
      "tok-3",
    );
    const window = fakeWindow();
    const reject = vi.fn();
    const other = fakeWindow();
    f.orchestrator.state.handles.file.set(
      fileContentKey("doc-9"),
      other as never,
    );
    registerPendingWorkspaceContentWindow({
      pending: f.orchestrator.state.pending.file,
      key: fileContentKey("doc-1"),
      timeoutMs: 60_000,
      onTimeout: vi.fn(),
      record: {
        documentId: "doc-1",
        token: "tok-3",
        windowLabel: FILE_LABEL,
        window: window as never,
        resolve: vi.fn(),
        reject,
        kind: "file",
        stage: initialPendingStage("file"),
      } as never,
    });

    f.orchestrator.rollbackPending();

    expect(reject).toHaveBeenCalledTimes(1);
    expect((reject.mock.calls[0][0] as Error).message).toBe(
      "pty.detachedStateChanged",
    );
    expect(window.destroy).toHaveBeenCalledTimes(1);
    expect(f.coordinator.get(ref)?.phase).toBe("attached");
    expect(f.orchestrator.state.pending.file.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(other.destroy).not.toHaveBeenCalled();
  });

  it("forgetHandles clears both handle maps and never destroys a window", () => {
    const f = makeFixture();
    const a = fakeWindow();
    const b = fakeWindow();
    f.orchestrator.state.handles.pty.set(ptyContentKey("s1"), a as never);
    f.orchestrator.state.handles.file.set(fileContentKey("d1"), b as never);

    f.orchestrator.forgetHandles();

    expect(f.orchestrator.state.handles.pty.size).toBe(0);
    expect(f.orchestrator.state.handles.file.size).toBe(0);
    expect(a.destroy).not.toHaveBeenCalled();
    expect(b.destroy).not.toHaveBeenCalled();
  });

  it("listManagedFileWindows lists detached and pending file windows but not plain attached ones", () => {
    const f = makeFixture({ withFile: true });
    makeDetached(f, { kind: "file", documentId: "doc-1" }, FILE_LABEL, "tok-5");
    registerPendingWorkspaceContentWindow({
      pending: f.orchestrator.state.pending.file,
      key: fileContentKey("doc-2"),
      timeoutMs: 60_000,
      onTimeout: vi.fn(),
      record: {
        documentId: "doc-2",
        token: "tok-6",
        windowLabel: OTHER_LABEL,
        window: fakeWindow() as never,
        resolve: vi.fn(),
        reject: vi.fn(),
        kind: "file",
        stage: initialPendingStage("file"),
      } as never,
    });
    f.coordinator.ensureAttached({ kind: "file", documentId: "doc-3" }, SOURCE);
    f.coordinator.ensureAttached({ kind: "pty", slotId: "s9" }, SOURCE);

    const listed = f.orchestrator
      .listManagedFileWindows()
      .sort((left, right) => left.documentId.localeCompare(right.documentId));

    expect(listed).toEqual([
      { documentId: "doc-1", token: "tok-5", windowLabel: FILE_LABEL },
      { documentId: "doc-2", token: "tok-6", windowLabel: OTHER_LABEL },
    ]);
  });

  it("disposeAll rejects pending windows with the unmount error and leaves attached handles alone", () => {
    vi.useFakeTimers();
    const f = makeFixture({ withFile: true });
    const window = fakeWindow();
    const reject = vi.fn();
    const attached = fakeWindow();
    registerPendingWorkspaceContentWindow({
      pending: f.orchestrator.state.pending.file,
      key: fileContentKey("doc-1"),
      timeoutMs: 60_000,
      onTimeout: vi.fn(),
      record: {
        documentId: "doc-1",
        token: "tok-7",
        windowLabel: FILE_LABEL,
        window: window as never,
        resolve: vi.fn(),
        reject,
        kind: "file",
        stage: initialPendingStage("file"),
      } as never,
    });
    f.orchestrator.state.handles.file.set(
      fileContentKey("doc-9"),
      attached as never,
    );

    f.orchestrator.disposeAll();

    expect(reject).toHaveBeenCalledTimes(1);
    expect((reject.mock.calls[0][0] as Error).message).toBe(
      "工作区内容宿主已卸载",
    );
    expect(window.destroy).toHaveBeenCalledTimes(1);
    expect(f.orchestrator.state.pending.file.size).toBe(0);
    expect(attached.destroy).not.toHaveBeenCalled();
    expect(f.orchestrator.state.handles.file.has(fileContentKey("doc-9"))).toBe(
      true,
    );
  });

  it("creating an orchestrator registers no listener, timer or window", () => {
    vi.useFakeTimers();
    const f = makeFixture({ withFile: true });

    expect(vi.getTimerCount()).toBe(0);
    expect(f.ports.createWindow).not.toHaveBeenCalled();
    expect(f.ports.getWindowByLabel).not.toHaveBeenCalled();
    expect(
      f.orchestrator.state.handles.pty.size +
        f.orchestrator.state.handles.file.size +
        f.orchestrator.state.pending.pty.size +
        f.orchestrator.state.pending.file.size,
    ).toBe(0);
    expect(f.orchestrator.state.returnWaitAbort.current).toBeNull();
  });
  it("detachFile throws the loading error when no pane holds the file", async () => {
    const f = makeFixture();

    await expect(f.orchestrator.detachFile("missing")).rejects.toThrow(
      "workspaceFiles.loadingFile",
    );
    expect(f.ports.createWindow).not.toHaveBeenCalled();
    expect(f.ports.grantFile).not.toHaveBeenCalled();
    expect(
      f.coordinator.get({ kind: "file", documentId: "missing" }),
    ).toBeUndefined();
  });

  it("detachFile revokes the grant and fails the handoff when the child window reports a creation error", async () => {
    const f = makeFixture({ withFile: true });
    const onceCallbacks: Array<(event: { payload: unknown }) => void> = [];
    f.child.once = vi.fn(
      async (
        _name: string,
        callback: (event: { payload: unknown }) => void,
      ) => {
        onceCallbacks.push(callback);
        return () => undefined;
      },
    ) as never;

    const outcome = f.orchestrator.detachFile("doc-1").then(
      () => "resolved",
      (reason: unknown) => reason,
    );
    // 授权与窗口创建都是异步的：最多等待 20 个微任务，超出则用例失败。
    for (let turn = 0; turn < 20 && onceCallbacks.length === 0; turn++) {
      await Promise.resolve();
    }
    expect(onceCallbacks).toHaveLength(1);

    onceCallbacks[0]({ payload: "denied" });
    const reason = await outcome;

    expect(reason).toBeInstanceOf(Error);
    expect(f.ports.revokeFile).toHaveBeenCalledTimes(1);
    expect(f.ports.revokeFile.mock.calls[0][0]).toBe(
      f.ports.createWindow.mock.calls[0][0].label,
    );
    expect(
      f.coordinator.get({ kind: "file", documentId: "doc-1" })?.phase,
    ).toBe("attached");
    expect(f.ports.grantFile).toHaveBeenCalledTimes(1);
    expect(f.orchestrator.state.pending.file.size).toBe(0);
  });
});

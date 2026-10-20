// @vitest-environment jsdom
import type { TFunction } from "i18next";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Directory, WorkspaceLayoutDocument } from "../../lib/tauri";
import {
  addWorkspaceFileToPane,
  createWorkspacePane,
  type WorkspaceNode,
} from "../../lib/ptyWorkspaceLayout";
import { WorkspaceContentCoordinator } from "../../lib/workspaceContentCoordinator";
import { createWorkspaceFileBuffer } from "../../lib/workspaceFileBuffer";
import { createWorkspaceLayoutDocument } from "../../lib/workspaceLayoutPersistence";
import {
  createInitialHostSnapshot,
  WorkspaceHostStore,
} from "../host/workspaceHostStore";
import {
  createWorkspacePersistence,
  type WorkspacePersistenceDeps,
} from "./workspacePersistence";

const DIRECTORY_FIXTURE = {
  id: 1,
  path: "C:/project",
  name: "project",
} as Directory;
const DOC_A = {
  id: "doc-a",
  directoryId: 1,
  directoryPath: "C:/project",
  relativePath: "a.txt",
};
const DOC_B = {
  id: "doc-b",
  directoryId: 1,
  directoryPath: "C:/project",
  relativePath: "b.txt",
};
const BUFFER = createWorkspaceFileBuffer({
  kind: "text",
  content: "c",
  revision: "r",
});
const SOURCE = { kind: "pane", windowLabel: "main", paneId: "pane-1" } as const;
const CHILD_LABEL = "workspace-content-8e783338-f464-4b10-b15e-b534748c6241";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function readyRead(documents: (typeof DOC_A)[] = []) {
  let tree: WorkspaceNode = createWorkspacePane("pane-1");
  for (const doc of documents)
    tree = addWorkspaceFileToPane(tree, "pane-1", doc.id);
  const layout = createWorkspaceLayoutDocument({
    tree,
    focusedPaneId: "pane-1",
    slots: [],
    documents,
    detachedContents: [],
  });
  return {
    status: { status: "ready" as const },
    revision: 5,
    schemaVersion: layout.schemaVersion,
    updatedAtMs: 1,
    layout,
    slotStates: [],
  };
}

const missingRead = {
  status: { status: "missing" as const },
  revision: 0,
  schemaVersion: null,
  updatedAtMs: null,
  layout: null,
  slotStates: [],
};

function makeFixture() {
  const store = new WorkspaceHostStore(createInitialHostSnapshot("pane-1"));
  const coordinator = new WorkspaceContentCoordinator();
  const translate = ((key: string) => key) as unknown as TFunction;
  const ports = {
    getWorkspaceLayout: vi.fn(async () => missingRead),
    saveWorkspaceLayout: vi.fn(
      async (revision: number, _layout: WorkspaceLayoutDocument) => ({
        saved: true,
        revision,
      }),
    ),
    resetWorkspaceLayout: vi.fn(async () => 7),
    planApplyWorkspaceLayoutPreset: vi.fn(),
  };
  const order: string[] = [];
  const runtimeSteps = vi.fn((reason: string) => ({
    rollbackPending: () => order.push(`${reason}:rollbackPending`),
    forgetWindowHandles: () => order.push(`${reason}:forgetWindowHandles`),
    releaseDocuments: () => order.push(`${reason}:releaseDocuments`),
    clearPtyRuntime: () => order.push(`${reason}:clearPtyRuntime`),
    rebuildCoordinator: () => order.push(`${reason}:rebuildCoordinator`),
  }));
  const invalidateDocuments = vi.fn();
  const releaseDocuments = vi.fn();
  const deps: WorkspacePersistenceDeps = {
    store,
    getCoordinator: () => coordinator,
    getDirectories: () => [DIRECTORY_FIXTURE],
    translate,
    initialPaneId: "pane-1",
    runtimeSteps:
      runtimeSteps as unknown as WorkspacePersistenceDeps["runtimeSteps"],
    invalidateDocuments,
    releaseDocuments,
    ports: ports as unknown as WorkspacePersistenceDeps["ports"],
  };
  return {
    persistence: createWorkspacePersistence(deps),
    store,
    coordinator,
    ports,
    order,
    runtimeSteps,
    invalidateDocuments,
    releaseDocuments,
  };
}

type Fixture = ReturnType<typeof makeFixture>;
const saves = (f: Fixture) => f.ports.saveWorkspaceLayout.mock.calls.length;
// 订阅驱动的保存合并在一个微任务里；有上限的循环，不依赖真实时间。
async function settle() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("workspacePersistence", () => {
  it("hydrate with a missing layout becomes ready and creates a save queue at revision 0", async () => {
    const f = makeFixture();
    f.persistence.schedulePersist();
    expect(saves(f)).toBe(0);

    await f.persistence.hydrate();
    expect(f.store.getSnapshot().hydrationStatus).toBe("ready");
    f.persistence.schedulePersist();
    expect(saves(f)).toBe(1);
    expect(f.ports.saveWorkspaceLayout.mock.calls[0][0]).toBe(1);
    expect(f.persistence.getStatus().hydrationError).toBeNull();
  });

  it("hydrate with needsReset publishes the reason and stays unsaved", async () => {
    const f = makeFixture();
    f.ports.getWorkspaceLayout.mockResolvedValue({
      ...missingRead,
      status: {
        status: "needsReset",
        reason: { code: "invalidPayload", detail: "bad" },
      } as never,
      revision: 3,
    });
    await f.persistence.hydrate();
    expect(f.store.getSnapshot().hydrationStatus).toBe("needsReset");
    expect(f.persistence.getStatus().hydrationError).toEqual({
      code: "layout.needs_reset",
      message: "bad",
    });
    f.persistence.schedulePersist();
    expect(saves(f)).toBe(0);
    expect(f.runtimeSteps).not.toHaveBeenCalled();
  });

  it("hydrate failure publishes loadFailed with the formatted error", async () => {
    const f = makeFixture();
    f.ports.getWorkspaceLayout.mockRejectedValue(new Error("boom"));
    await f.persistence.hydrate();
    expect(f.store.getSnapshot().hydrationStatus).toBe("loadFailed");
    expect(f.persistence.getStatus().hydrationError?.message).toContain("boom");
    expect(saves(f)).toBe(0);
  });

  it("a stale hydrate request is ignored", async () => {
    const f = makeFixture();
    const d1 = deferred<ReturnType<typeof readyRead>>();
    f.ports.getWorkspaceLayout
      .mockImplementationOnce(() => d1.promise as never)
      .mockImplementationOnce(async () => readyRead([DOC_B]) as never);

    const first = f.persistence.hydrate();
    const second = f.persistence.hydrate();
    await second;
    d1.resolve(readyRead([DOC_A]));
    await first;

    expect(f.store.getSnapshot().documents.map((d) => d.id)).toEqual(["doc-b"]);
    expect(f.runtimeSteps).toHaveBeenCalledTimes(1);
  });

  it("schedulePersist enqueues the snapshot with its documents and focus", async () => {
    const f = makeFixture();
    f.ports.getWorkspaceLayout.mockResolvedValue(readyRead([DOC_A]) as never);
    await f.persistence.hydrate();

    f.persistence.schedulePersist();
    expect(saves(f)).toBe(1);
    expect(
      f.ports.saveWorkspaceLayout.mock.calls[0][1].documents.map(
        (d: { id: string }) => d.id,
      ),
    ).toEqual(["doc-a"]);
    expect(f.ports.saveWorkspaceLayout.mock.calls[0][1].focusedPaneId).toBe(
      "pane-1",
    );

    f.persistence.restoreLatch.active = true;
    f.persistence.schedulePersist();
    expect(saves(f)).toBe(1);
  });

  it("a failing save publishes layoutSaveError and a later success clears it", async () => {
    const f = makeFixture();
    await f.persistence.hydrate();
    f.ports.saveWorkspaceLayout.mockRejectedValueOnce(new Error("disk full"));
    const listener = vi.fn();
    const unsubscribe = f.persistence.subscribeStatus(listener);

    f.persistence.schedulePersist();
    await f.persistence.flush();
    expect(f.persistence.getStatus().layoutSaveError?.message).toContain(
      "disk full",
    );

    f.persistence.schedulePersist();
    await f.persistence.flush();
    expect(f.persistence.getStatus().layoutSaveError).toBeNull();
    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(2);

    unsubscribe();
    const before = listener.mock.calls.length;
    f.ports.saveWorkspaceLayout.mockRejectedValueOnce(new Error("again"));
    f.persistence.schedulePersist();
    await f.persistence.flush();
    expect(f.persistence.getStatus().layoutSaveError?.message).toContain(
      "again",
    );
    expect(listener.mock.calls.length).toBe(before);
  });

  it("startAutoPersist saves on tree, document, focus, slot and status changes and ignores buffer and revision changes", async () => {
    const f = makeFixture();
    await f.persistence.hydrate();
    const stop = f.persistence.startAutoPersist();
    const b0 = saves(f);

    f.store.commit(
      (live) => ({ ...live, buffers: { x: BUFFER } }),
      "t:buffers",
    );
    await settle();
    expect(saves(f)).toBe(b0);
    f.store.commit(
      (live) => ({ ...live, treeRevision: live.treeRevision + 1 }),
      "t:rev",
    );
    await settle();
    expect(saves(f)).toBe(b0);
    f.store.commit(
      (live) => ({
        ...live,
        documents: [DOC_A],
        tree: addWorkspaceFileToPane(live.tree, "pane-1", "doc-a"),
      }),
      "t:doc",
    );
    await settle();
    expect(saves(f)).toBe(b0 + 1);

    // 同步突发只保存一次，并且保存的是落定后的状态：
    // 第一次提交让树引用了 doc-b 但 documents 里还没有它（非法中间态），第二次补齐。
    f.store.commit(
      (live) => ({
        ...live,
        tree: addWorkspaceFileToPane(live.tree, "pane-1", "doc-b"),
      }),
      "t:tree-b",
    );
    f.store.commit(
      (live) => ({ ...live, documents: [DOC_A, DOC_B] }),
      "t:docs-b",
    );
    await settle();
    expect(saves(f)).toBe(b0 + 2);
    expect(
      f.ports.saveWorkspaceLayout.mock.calls[b0 + 1][1].documents.map(
        (d: { id: string }) => d.id,
      ),
    ).toEqual(["doc-a", "doc-b"]);
    expect(f.persistence.getStatus().layoutSaveError).toBeNull();

    stop();
    f.store.commit(
      (live) => ({
        ...live,
        documents: [DOC_A],
        tree: addWorkspaceFileToPane(live.tree, "pane-1", "doc-c"),
      }),
      "t:doc2",
    );
    await settle();
    expect(saves(f)).toBe(b0 + 2);

    const g = makeFixture();
    g.persistence.startAutoPersist();
    g.store.commit(
      (live) => ({ ...live, documents: [DOC_A] }),
      "t:docBeforeHydrate",
    );
    await settle();
    expect(saves(g)).toBe(0);
  });

  it("startAutoPersist saves on every coordinator revision and stops after unsubscribe", async () => {
    const f = makeFixture();
    await f.persistence.hydrate();
    const stop = f.persistence.startAutoPersist();
    const b0 = saves(f);
    const ref = { kind: "file", documentId: "doc-a" } as const;

    f.coordinator.ensureAttached(ref, SOURCE);
    await settle();
    expect(saves(f)).toBe(b0 + 1);

    stop();
    f.coordinator.ensureAttached({ kind: "file", documentId: "doc-b" }, SOURCE);
    await settle();
    expect(saves(f)).toBe(b0 + 1);

    const g = makeFixture();
    await g.persistence.hydrate();
    g.coordinator.ensureAttached({ kind: "file", documentId: "doc-z" }, SOURCE);
    await settle();
    expect(saves(g)).toBe(0);
  });

  it("schedulePersistAfterResize debounces to one save per 500 ms window and cancelResizePersist cancels it", async () => {
    vi.useFakeTimers();
    const f = makeFixture();
    await f.persistence.hydrate();
    const b0 = saves(f);

    f.persistence.schedulePersistAfterResize();
    f.persistence.schedulePersistAfterResize();
    vi.advanceTimersByTime(499);
    expect(saves(f)).toBe(b0);
    vi.advanceTimersByTime(1);
    expect(saves(f)).toBe(b0 + 1);
    // 若防抖失效，会有两次入队：排队的第二次保存在队列落地后才可见。
    await f.persistence.flush();
    expect(saves(f)).toBe(b0 + 1);

    f.persistence.schedulePersistAfterResize();
    f.persistence.cancelResizePersist();
    vi.advanceTimersByTime(1000);
    expect(saves(f)).toBe(b0 + 1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("dispose persists the latest snapshot, flushes the queue and clears the resize timer", async () => {
    vi.useFakeTimers();
    const f = makeFixture();
    await f.persistence.hydrate();
    const b0 = saves(f);
    f.persistence.schedulePersistAfterResize();

    f.persistence.dispose();
    expect(saves(f)).toBe(b0 + 1);
    expect(vi.getTimerCount()).toBe(0);

    const g = makeFixture();
    g.persistence.dispose();
    expect(saves(g)).toBe(0);
  });

  it("rehydrate runs the runtime reset in the fixed order, clears the latch and hydrates again", async () => {
    const f = makeFixture();
    const second = deferred<ReturnType<typeof readyRead>>();
    f.ports.getWorkspaceLayout
      .mockResolvedValueOnce(readyRead([DOC_A]) as never)
      .mockImplementationOnce(() => second.promise as never);
    await f.persistence.hydrate();
    f.order.length = 0;
    f.persistence.restoreLatch.active = true;

    const pending = f.persistence.rehydrate();
    // 重置之后、第二次 hydrate 完成之前：队列已被丢弃，schedulePersist 不保存。
    const duringRehydrate = saves(f);
    f.persistence.schedulePersist();
    expect(saves(f)).toBe(duringRehydrate);
    second.resolve(readyRead([DOC_B]));
    await pending;

    expect(f.order.filter((entry) => entry.startsWith("rehydrate:"))).toEqual([
      "rehydrate:rollbackPending",
      "rehydrate:forgetWindowHandles",
      "rehydrate:releaseDocuments",
      "rehydrate:clearPtyRuntime",
      "rehydrate:rebuildCoordinator",
    ]);
    expect(f.persistence.restoreLatch.active).toBe(false);
    expect(f.ports.getWorkspaceLayout).toHaveBeenCalledTimes(2);
    expect(f.store.getSnapshot().documents.map((d) => d.id)).toEqual(["doc-b"]);
    expect(f.store.getSnapshot().hydrationStatus).toBe("ready");
  });

  it("resetWorkspace only runs from needsReset and publishes layoutResetPending around the call", async () => {
    const f = makeFixture();
    f.ports.getWorkspaceLayout.mockResolvedValue({
      ...missingRead,
      status: {
        status: "needsReset",
        reason: { code: "invalidPayload", detail: "bad" },
      } as never,
    });
    await f.persistence.hydrate();
    const d = deferred<number>();
    f.ports.resetWorkspaceLayout.mockImplementationOnce(() => d.promise);

    const p = f.persistence.resetWorkspace();
    expect(f.persistence.getStatus().layoutResetPending).toBe(true);
    d.resolve(9);
    await p;
    expect(f.persistence.getStatus().layoutResetPending).toBe(false);
    expect(f.store.getSnapshot().hydrationStatus).toBe("ready");
    expect(f.persistence.getStatus().hydrationError).toBeNull();
    f.persistence.schedulePersist();
    expect(f.ports.saveWorkspaceLayout.mock.calls[0][0]).toBe(10);

    const failing = makeFixture();
    failing.ports.getWorkspaceLayout.mockResolvedValue({
      ...missingRead,
      status: {
        status: "needsReset",
        reason: { code: "invalidPayload", detail: "bad" },
      } as never,
    });
    await failing.persistence.hydrate();
    failing.ports.resetWorkspaceLayout.mockRejectedValueOnce(new Error("nope"));
    await expect(failing.persistence.resetWorkspace()).rejects.toThrow("nope");
    expect(failing.persistence.getStatus().layoutResetError?.message).toContain(
      "nope",
    );

    const ready = makeFixture();
    await ready.persistence.hydrate();
    await ready.persistence.resetWorkspace();
    expect(ready.ports.resetWorkspaceLayout).not.toHaveBeenCalled();
  });

  it("applyPreset rejects when the workspace changes while the plan is computed", async () => {
    const f = makeFixture();
    f.ports.getWorkspaceLayout.mockResolvedValue(readyRead([DOC_A]) as never);
    await f.persistence.hydrate();
    const d = deferred<unknown>();
    f.ports.planApplyWorkspaceLayoutPreset.mockImplementationOnce(
      () => d.promise,
    );

    const p = f.persistence.applyPreset("preset-1");
    f.store.commit(
      (live) => ({
        ...live,
        tree: addWorkspaceFileToPane(live.tree, "pane-1", "doc-extra"),
      }),
      "t:change",
    );
    const changedTree = f.store.getSnapshot().tree;
    d.resolve({});
    await expect(p).rejects.toThrow("pty.layoutChangedDuringApply");
    expect(f.store.getSnapshot().tree).toBe(changedTree);

    const idle = makeFixture();
    await idle.persistence.applyPreset("x");
    expect(idle.ports.planApplyWorkspaceLayoutPreset).not.toHaveBeenCalled();
  });

  it("currentPresetLayout excludes protected detached contents", async () => {
    const f = makeFixture();
    f.ports.getWorkspaceLayout.mockResolvedValue(
      readyRead([DOC_A, DOC_B]) as never,
    );
    await f.persistence.hydrate();
    const ref = { kind: "file", documentId: "doc-b" } as const;
    f.coordinator.ensureAttached(ref, SOURCE);
    f.coordinator.beginDetach(
      ref,
      SOURCE,
      { kind: "window", windowLabel: CHILD_LABEL },
      "tok",
    );
    f.coordinator.completeHandoff(ref, "detachReady", "tok", "window-tok");

    const layout = f.persistence.currentPresetLayout();
    expect(layout.documents.map((d) => d.id)).toEqual(["doc-a"]);
    expect(layout.detachedContents).toEqual([]);

    const plain = makeFixture();
    plain.ports.getWorkspaceLayout.mockResolvedValue(
      readyRead([DOC_A, DOC_B]) as never,
    );
    await plain.persistence.hydrate();
    expect(
      plain.persistence.currentPresetLayout().documents.map((d) => d.id),
    ).toEqual(["doc-a", "doc-b"]);
  });

  it("dispose does not end the instance: hydrate and persist work again after it", async () => {
    const f = makeFixture();
    await f.persistence.hydrate();
    f.persistence.dispose();
    const b0 = saves(f);

    await f.persistence.hydrate();
    expect(f.store.getSnapshot().hydrationStatus).toBe("ready");
    f.persistence.schedulePersist();
    expect(saves(f)).toBe(b0 + 1);
    expect(typeof f.persistence.startAutoPersist()).toBe("function");

    expect(() => {
      f.persistence.dispose();
      f.persistence.dispose();
    }).not.toThrow();
  });
});

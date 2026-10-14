import type { TFunction } from "i18next";
import {
  getWorkspaceLayout,
  planApplyWorkspaceLayoutPreset,
  resetWorkspaceLayout,
  saveWorkspaceLayout,
  type Directory,
  type WorkspaceFileDocument,
  type WorkspaceLayoutDocument,
  type WorkspaceLayoutSlot,
} from "../../lib/tauri";
import type { PtyWorkspaceSlot } from "../../components/WorkspacePtySessionRegistry";
import { toWorkspaceLayoutSlot } from "./workspaceLayoutSlot";
import {
  createPersistenceStatus,
  type PersistenceStatus,
} from "./persistenceStatus";

export type { PersistenceStatus };
import {
  restoreLayoutSnapshot,
  guardRebuildCoordinator,
} from "./workspaceRestoreSnapshot";
import { applyStateStillCurrent, captureApplyState } from "./presetApplyState";
import {
  activePresetLayoutFrom,
  currentPresetLayoutFrom,
  restorePresetPlan,
} from "./workspacePresetLayout";

export { toWorkspaceLayoutSlot };
import {
  createWorkspaceLayoutDocument,
  listPersistedDetachedContents,
  restoreWorkspaceLayoutApplyPlan,
  UnsupportedWorkspaceLayoutVersionError,
  WorkspaceLayoutSaveQueue,
} from "../../lib/workspaceLayoutPersistence";
import {
  createWorkspacePane,
  type WorkspaceNode,
  listWorkspacePanes,
} from "../../lib/ptyWorkspaceLayout";

import { formatAppError } from "../../lib/appErrors";
import { droppedFileDocumentIds } from "../../lib/workspaceFileDocumentRelease";
import type { WorkspaceContentCoordinator } from "../../lib/workspaceContentCoordinator";
import type {
  HostSnapshot,
  WorkspaceHostStore,
} from "../host/workspaceHostStore";
import {
  resetHostRuntime,
  type HostResetReason,
  type HostRuntimeSteps,
} from "../host/resetHostRuntime";

export interface WorkspacePersistencePorts {
  getWorkspaceLayout: typeof getWorkspaceLayout;
  saveWorkspaceLayout: typeof saveWorkspaceLayout;
  resetWorkspaceLayout: typeof resetWorkspaceLayout;
  planApplyWorkspaceLayoutPreset: typeof planApplyWorkspaceLayoutPreset;
}

export const defaultWorkspacePersistencePorts: WorkspacePersistencePorts = {
  getWorkspaceLayout,
  saveWorkspaceLayout,
  resetWorkspaceLayout,
  planApplyWorkspaceLayoutPreset,
};

/** What a runtime reset needs to know about the layout that replaces the old one. */
export interface RuntimeResetNext {
  tree: WorkspaceNode;
  documents: WorkspaceFileDocument[];
}

export interface WorkspacePersistenceDeps {
  store: WorkspaceHostStore;
  getCoordinator: () => WorkspaceContentCoordinator;
  /** Latest project list; read at save time, never a trigger. */
  getDirectories: () => Directory[] | undefined;
  translate: TFunction;
  initialPaneId: string;
  /** Builds the runtime reset steps (m6-048); the host wires windows and domains. */
  runtimeSteps: (
    reason: HostResetReason,
    next: RuntimeResetNext | null,
  ) => HostRuntimeSteps;
  /** Invalidates in-flight file loads of these documents (fileDomain.invalidateLoads). */
  invalidateDocuments: (documentIds: Iterable<string>) => void;
  /** Releases file documents that are no longer part of the layout (host adapter release). */
  releaseDocuments: (documentIds: readonly string[]) => void;
  ports?: Partial<WorkspacePersistencePorts>;
}

export interface WorkspacePersistence {
  hydrate(): Promise<void>;
  retryHydration(): void;
  rehydrate(): Promise<void>;
  resetWorkspace(): Promise<void>;
  /** Enqueues the latest snapshot; no-op unless hydrated and not restoring. */
  schedulePersist(treeOverride?: WorkspaceNode): void;
  /** Debounced (500 ms) persist used while a split sash is dragged. */
  schedulePersistAfterResize(): void;
  cancelResizePersist(): void;
  /** Subscribes to the store and the coordinator once; returns the unsubscribe. */
  startAutoPersist(): () => void;
  /** Makes results of in-flight hydrate calls stale (unmount). */
  invalidateHydration(): void;
  /** Current hydrate request number; file documents compare it to drop stale loads. */
  hydrationEpoch(): number;
  /** Unmount: stops the resize timer, persists the latest snapshot, flushes and disposes the queue. */
  dispose(): void;
  flush(): Promise<void>;
  applyPreset(presetId: string): Promise<void>;
  currentPresetLayout(): WorkspaceLayoutDocument;
  /** Replaces the old backupRestoreInProgressRef: persist is skipped while active. */
  readonly restoreLatch: { active: boolean };
  getStatus(): PersistenceStatus;
  subscribeStatus(listener: () => void): () => void;
}

/** Fields whose change can make a snapshot differ. Changes of other fields never save. */
const PERSIST_KEYS = [
  "tree",
  "focusedPaneId",
  "slots",
  "documents",
  "hydrationStatus",
] as const satisfies readonly (keyof HostSnapshot)[];

function samePersistKey(left: HostSnapshot, right: HostSnapshot): boolean {
  return PERSIST_KEYS.every((key) => Object.is(left[key], right[key]));
}

export const RESIZE_PERSIST_DELAY_MS = 500;

/** Builds deps whose members always read the newest deps stored in the ref (R-FE-1). */
export function latestPersistenceDeps(
  ref: { current: WorkspacePersistenceDeps | null },
  store: WorkspaceHostStore,
): WorkspacePersistenceDeps {
  const current = (): WorkspacePersistenceDeps => {
    if (!ref.current) throw new Error("persistence deps are not ready");
    return ref.current;
  };
  return {
    store,
    getCoordinator: () => current().getCoordinator(),
    getDirectories: () => current().getDirectories(),
    get translate() {
      return current().translate;
    },
    get initialPaneId() {
      return current().initialPaneId;
    },
    runtimeSteps: (reason, next) => current().runtimeSteps(reason, next),
    invalidateDocuments: (ids) => current().invalidateDocuments(ids),
    releaseDocuments: (ids) => current().releaseDocuments(ids),
    get ports() {
      return ref.current?.ports;
    },
  };
}

export function createWorkspacePersistence(
  deps: WorkspacePersistenceDeps,
): WorkspacePersistence {
  const ports: WorkspacePersistencePorts = {
    ...defaultWorkspacePersistencePorts,
    ...deps.ports,
  };
  const { store } = deps;
  // 以下三个可变量只在本模块内使用，不是 React ref，也不暴露给宿主。
  const saveQueueRef: { current: WorkspaceLayoutSaveQueue | null } = {
    current: null,
  };
  const hydrationRequestRef = { current: 0 };
  const ratioSaveTimerRef: { current: ReturnType<typeof setTimeout> | null } = {
    current: null,
  };
  const restoreLatch = { active: false };

  const statusStore = createPersistenceStatus();
  const setStatus = statusStore.set;
  const setHydrationError = (value: string | null) =>
    setStatus({ hydrationError: value });
  const setLayoutSaveError = (value: string | null) =>
    setStatus({ layoutSaveError: value });
  const setLayoutResetError = (value: string | null) =>
    setStatus({ layoutResetError: value });
  const setLayoutResetPending = (value: boolean) =>
    setStatus({ layoutResetPending: value });

  // 宿主状态的唯一写入口是 store.commit；与宿主里的 patchHost 同一实现。
  const patchHost = (patch: Partial<HostSnapshot>, reason: string) =>
    store.commit((live) => ({ ...live, ...patch }), reason);

  const createSaveQueue = (revision: number) =>
    new WorkspaceLayoutSaveQueue(
      revision,
      ports.saveWorkspaceLayout,
      (reason) => setLayoutSaveError(formatAppError(reason, deps.translate)),
      () => setLayoutSaveError(null),
    );

  const schedulePersist = (treeOverride?: WorkspaceNode) => {
    if (store.getLive().hydrationStatus !== "ready") return;
    if (restoreLatch.active) return;
    const queue = saveQueueRef.current;
    if (!queue) return;

    const snapshotTree = treeOverride ?? store.getLive().tree;
    // 快照构造不得把异常抛进 effect：根边界只能兜底成重载提示（丢失未保存缓冲），
    // 所以这里降级为一次可自愈的保存错误，下一次状态变化会重新保存。
    try {
      const persistedSlots: WorkspaceLayoutSlot[] = store
        .getLive()
        .slots.map((slot) =>
          toWorkspaceLayoutSlot(slot, deps.getDirectories() ?? []),
        );
      queue.enqueue(
        createWorkspaceLayoutDocument({
          tree: snapshotTree,
          focusedPaneId: store.getLive().focusedPaneId,
          slots: persistedSlots,
          documents: store.getLive().documents,
          detachedContents: listPersistedDetachedContents(
            deps.getCoordinator().listWindowOwned(),
            snapshotTree,
          ),
        }),
      );
    } catch (reason) {
      setLayoutSaveError(formatAppError(reason, deps.translate));
      console.error("[workspace.layout_snapshot_invalid]", reason);
    }
  };

  const hydrate = async () => {
    const requestId = ++hydrationRequestRef.current;
    patchHost({ hydrationStatus: "loading" }, "hydrate:loading");
    setHydrationError(null);
    setLayoutResetError(null);
    saveQueueRef.current = null;

    try {
      const read = await ports.getWorkspaceLayout();
      if (requestId !== hydrationRequestRef.current) return;
      const revision = read.revision ?? 0;

      if (read.status.status === "needsReset") {
        setHydrationError(read.status.reason);
        patchHost({ hydrationStatus: "needsReset" }, "hydrate:needsReset");
        return;
      }

      let restoredPatch: Partial<HostSnapshot> = {};
      if (read.status.status === "ready") {
        if (!read.layout) {
          throw new Error(deps.translate("pty.layoutDataMissing"));
        }
        const restoredSnapshot = restoreLayoutSnapshot(
          read.layout,
          read.slotStates,
        );
        const restoredSlots: PtyWorkspaceSlot[] = restoredSnapshot.slots;
        // 协调器重建失败时与原实现一致：执行完其余步骤后进入 loadFailed，不发布半更新的状态。
        const guarded = guardRebuildCoordinator(
          deps.runtimeSteps("hydrate", {
            tree: restoredSnapshot.tree,
            documents: restoredSnapshot.documents ?? [],
          }),
        );
        resetHostRuntime("hydrate", guarded.steps);
        if (guarded.failure.failed) throw guarded.failure.error;
        restoredPatch = {
          slots: restoredSlots,
          documents: restoredSnapshot.documents ?? [],
          buffers: {},
          tree: restoredSnapshot.tree,
          focusedPaneId: restoredSnapshot.focusedPaneId,
        };
      }

      saveQueueRef.current = createSaveQueue(revision);
      setLayoutSaveError(null);
      patchHost({ ...restoredPatch, hydrationStatus: "ready" }, "hydrated");
    } catch (reason) {
      if (requestId !== hydrationRequestRef.current) return;
      if (reason instanceof UnsupportedWorkspaceLayoutVersionError) {
        setHydrationError(reason.message);
        patchHost({ hydrationStatus: "needsReset" }, "hydrate:needsReset");
        return;
      }
      setHydrationError(formatAppError(reason, deps.translate));
      patchHost({ hydrationStatus: "loadFailed" }, "hydrate:loadFailed");
    }
  };

  const retryHydration = () => {
    void hydrate();
  };

  const rehydrate = async () => {
    restoreLatch.active = false;
    resetHostRuntime("rehydrate", deps.runtimeSteps("rehydrate", null));
    saveQueueRef.current = null;
    patchHost(
      {
        ptySessionsById: {},
        slots: [],
        documents: [],
        buffers: {},
        tree: createWorkspacePane(deps.initialPaneId),
        focusedPaneId: deps.initialPaneId,
        treeRevision: store.getLive().treeRevision + 1,
      },
      "rehydrateWorkspace:reset",
    );
    await hydrate();
  };

  const resetWorkspace = async () => {
    if (store.getLive().hydrationStatus !== "needsReset") return;
    setLayoutResetPending(true);
    setLayoutResetError(null);
    try {
      const revision = await ports.resetWorkspaceLayout();
      saveQueueRef.current = createSaveQueue(revision);
      setHydrationError(null);
      setLayoutSaveError(null);
      patchHost({ hydrationStatus: "ready" }, "resetWorkspace:ready");
    } catch (reason) {
      setLayoutResetError(formatAppError(reason, deps.translate));
      throw reason;
    } finally {
      setLayoutResetPending(false);
    }
  };

  const applyPreset = async (presetId: string) => {
    if (store.getLive().hydrationStatus !== "ready") return;
    const protectedContents = deps.getCoordinator().listWindowOwned();
    const expectedState = captureApplyState(store.getLive(), protectedContents);
    const activeLayout = activePresetLayoutFrom({
      live: store.getLive(),
      detachedContents: deps.getCoordinator().listInPhases("detached"),
      protectedContents,
      directories: deps.getDirectories() ?? [],
    });
    const plan = await ports.planApplyWorkspaceLayoutPreset(
      presetId,
      activeLayout,
    );
    if (
      !applyStateStillCurrent(
        expectedState,
        store.getLive(),
        deps.getCoordinator().listWindowOwned(),
      )
    ) {
      throw new Error(deps.translate("pty.layoutChangedDuringApply"));
    }
    const restored = restoreWorkspaceLayoutApplyPlan(plan);
    const currentDocuments = store.getLive().documents;
    deps.invalidateDocuments(
      new Set([
        ...currentDocuments.map((document) => document.id),
        ...(restored.documents ?? []).map((document) => document.id),
      ]),
    );
    const computed = restorePresetPlan({
      restored,
      currentDocuments,
      detachedNow: deps.getCoordinator().listInPhases("detached"),
      detachingNow: deps.getCoordinator().listInPhases("detaching"),
    });

    // 必须在上面的状态一致性检查之后登记，否则检查失败时 coordinator 已被污染。
    for (const pane of listWorkspacePanes(computed.restoredTree)) {
      for (const content of pane.contents) {
        if (content.kind === "unknown") continue;
        deps.getCoordinator().ensureAttached(content, {
          kind: "pane",
          windowLabel: "main",
          paneId: pane.id,
        });
      }
    }

    deps.releaseDocuments(
      droppedFileDocumentIds(currentDocuments, computed.nextDocuments),
    );
    patchHost(
      {
        slots: computed.restoredSlots,
        documents: computed.nextDocuments,
        tree: computed.restoredTree,
        focusedPaneId: computed.focusedPaneId,
      },
      "applyWorkspaceLayoutPreset:apply",
    );
  };

  const currentPresetLayout = (): WorkspaceLayoutDocument =>
    currentPresetLayoutFrom({
      live: store.getLive(),
      protectedContents: deps.getCoordinator().listWindowOwned(),
      directories: deps.getDirectories() ?? [],
    });

  const schedulePersistAfterResize = () => {
    if (ratioSaveTimerRef.current !== null) return;
    ratioSaveTimerRef.current = window.setTimeout(() => {
      ratioSaveTimerRef.current = null;
      schedulePersist();
    }, RESIZE_PERSIST_DELAY_MS);
  };

  const cancelResizePersist = () => {
    if (ratioSaveTimerRef.current === null) return;
    window.clearTimeout(ratioSaveTimerRef.current);
    ratioSaveTimerRef.current = null;
  };

  const startAutoPersist = () => {
    let last = store.getSnapshot();
    // 同步突发里的多次变化只保存一次，并且在它们全部落定之后保存：
    // detach / return 流程会在同一段同步代码里先后修改树与归属，中间态不是合法快照。
    let scheduled = false;
    let stopped = false;
    const scheduleSettled = () => {
      if (scheduled || stopped) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (!stopped) schedulePersist();
      });
    };
    const stopStore = store.subscribe(() => {
      const next = store.getSnapshot();
      if (samePersistKey(last, next)) {
        last = next;
        return;
      }
      last = next;
      scheduleSettled();
    });
    const stopCoordinator = deps
      .getCoordinator()
      .subscribe(() => scheduleSettled());
    return () => {
      stopped = true;
      stopStore();
      stopCoordinator();
    };
  };

  const invalidateHydration = () => {
    hydrationRequestRef.current += 1;
  };

  const dispose = () => {
    cancelResizePersist();
    if (store.getLive().hydrationStatus === "ready") {
      schedulePersist();
      const current = saveQueueRef.current;
      void current?.flush();
      current?.dispose();
    }
  };

  const flush = async () => {
    await saveQueueRef.current?.flush();
  };

  return {
    hydrate,
    retryHydration,
    rehydrate,
    resetWorkspace,
    schedulePersist,
    schedulePersistAfterResize,
    cancelResizePersist,
    startAutoPersist,
    invalidateHydration,
    hydrationEpoch: () => hydrationRequestRef.current,
    dispose,
    flush,
    applyPreset,
    currentPresetLayout,
    restoreLatch,
    getStatus: statusStore.get,
    subscribeStatus: statusStore.subscribe,
  };
}

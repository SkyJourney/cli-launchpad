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
import type {
  CommandOutcome,
  HostCommand,
} from "../host/workspaceCommandExecutor";
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
} from "../../lib/ptyWorkspaceLayout";

import { type AppErrorState, toAppErrorState } from "../../lib/appErrors";
import { UNKNOWN_PATH_SEMANTICS, type PathSemantics } from "../../lib/pathKey";
import { fileDocumentIdsOf } from "../../lib/caseVariantMerge";
import { hasUnsavedWorkspaceFileEdits } from "../../lib/workspaceFileBuffer";
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
  /** 命名布局应用的提交入口（m6-096）：状态检查、登记与树提交都在执行器里完成。 */
  execute: (command: HostCommand) => CommandOutcome;
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
  /** The probed path semantics per project (PD-10); omitted means `unknown`. */
  getPathSemantics?: (directoryId: number) => PathSemantics;
  /** A hydration begins: forget what was known about the old layout's projects. */
  onHydrateStart?: () => void;
  /** The hydrated layout is published; `epoch` is the hydration it belongs to. */
  afterHydrated?: (epoch: number) => void;
  /**
   * The backend refused the layout because of case duplicates (`documentIds`). `merge` merges
   * the variants, `degrade` drops the later ones; resolves to whether the host state changed.
   */
  repairCaseDuplicates?: (
    documentIds: readonly string[],
    mode: "merge" | "degrade",
    error: unknown,
  ) => Promise<boolean>;
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
    execute: (command) => current().execute(command),
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
    getPathSemantics: (directoryId) =>
      current().getPathSemantics?.(directoryId) ?? UNKNOWN_PATH_SEMANTICS,
    onHydrateStart: () => current().onHydrateStart?.(),
    afterHydrated: (epoch) => current().afterHydrated?.(epoch),
    repairCaseDuplicates: (documentIds, mode, error) =>
      current().repairCaseDuplicates?.(documentIds, mode, error) ??
      Promise.resolve(false),
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
  const setHydrationError = (value: AppErrorState | null) =>
    setStatus({ hydrationError: value });
  const setLayoutSaveError = (value: AppErrorState | null) =>
    setStatus({ layoutSaveError: value });
  const setLayoutResetError = (value: AppErrorState | null) =>
    setStatus({ layoutResetError: value });
  const setLayoutResetPending = (value: boolean) =>
    setStatus({ layoutResetPending: value });

  // 宿主状态的唯一写入口是 store.commit；与宿主里的 patchHost 同一实现。
  const patchHost = (patch: Partial<HostSnapshot>, reason: string) =>
    store.commit((live) => ({ ...live, ...patch }), reason);

  // While the host repairs case duplicates the repair itself must not trigger a save: the queue
  // either retries its own repaired layout or (after a degrade) waits for the next regular save.
  let persistSuppressed = 0;

  const createSaveQueue = (revision: number) =>
    new WorkspaceLayoutSaveQueue(
      revision,
      ports.saveWorkspaceLayout,
      (reason) => setLayoutSaveError(toAppErrorState(reason)),
      () => setLayoutSaveError(null),
      {
        repairCaseDuplicate: async (error, mode) => {
          const params =
            typeof error === "object" && error !== null && "params" in error
              ? (error as { params?: { documentIds?: unknown } }).params
              : undefined;
          const documentIds = Array.isArray(params?.documentIds)
            ? params.documentIds.filter(
                (id): id is string => typeof id === "string",
              )
            : [];
          persistSuppressed += 1;
          try {
            const changed = await (deps.repairCaseDuplicates?.(
              documentIds,
              mode,
              error,
            ) ?? Promise.resolve(false));
            // Let the microtask the repair's own commit queued run while still suppressed.
            await Promise.resolve();
            if (!changed) return { changed: false, document: null };
            if (mode === "degrade") return { changed: true, document: null };
            try {
              return { changed: true, document: buildLayoutDocument() };
            } catch {
              return { changed: false, document: null };
            }
          } finally {
            persistSuppressed -= 1;
          }
        },
      },
    );

  /** The layout document of the live host state; throws when the state is not a valid layout. */
  const buildLayoutDocument = (
    treeOverride?: WorkspaceNode,
  ): WorkspaceLayoutDocument => {
    const snapshotTree = treeOverride ?? store.getLive().tree;
    const persistedSlots: WorkspaceLayoutSlot[] = store
      .getLive()
      .slots.map((slot) =>
        toWorkspaceLayoutSlot(slot, deps.getDirectories() ?? []),
      );
    return createWorkspaceLayoutDocument({
      tree: snapshotTree,
      focusedPaneId: store.getLive().focusedPaneId,
      slots: persistedSlots,
      documents: store.getLive().documents,
      detachedContents: listPersistedDetachedContents(
        deps.getCoordinator().listWindowOwned(),
        snapshotTree,
      ),
    });
  };

  const schedulePersist = (treeOverride?: WorkspaceNode) => {
    if (store.getLive().hydrationStatus !== "ready") return;
    if (restoreLatch.active) return;
    if (persistSuppressed > 0) return;
    const queue = saveQueueRef.current;
    if (!queue) return;

    // 快照构造不得把异常抛进 effect：根边界只能兜底成重载提示（丢失未保存缓冲），
    // 所以这里降级为一次可自愈的保存错误，下一次状态变化会重新保存。
    try {
      queue.enqueue(buildLayoutDocument(treeOverride));
    } catch (reason) {
      setLayoutSaveError(toAppErrorState(reason));
      console.error("[workspace.layout_snapshot_invalid]", reason);
    }
  };

  const hydrate = async () => {
    const requestId = ++hydrationRequestRef.current;
    // Path semantics belong to the layout being replaced.
    deps.onHydrateStart?.();
    patchHost({ hydrationStatus: "loading" }, "hydrate:loading");
    setHydrationError(null);
    setLayoutResetError(null);
    saveQueueRef.current = null;

    try {
      const read = await ports.getWorkspaceLayout();
      if (requestId !== hydrationRequestRef.current) return;
      const revision = read.revision ?? 0;

      if (read.status.status === "needsReset") {
        console.warn(
          "[layout-reset]",
          read.status.reason.code,
          read.status.reason.detail,
        );
        setHydrationError({
          code: "layout.needs_reset",
          message: read.status.reason.detail,
        });
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
      // An explicit step after the layout is published, never an effect dependency (R-FE-1).
      try {
        deps.afterHydrated?.(requestId);
      } catch (reason) {
        // The layout is already published; a failed follow-up must not undo that.
        console.error("[workspace.after_hydrated_failed]", reason);
      }
    } catch (reason) {
      if (requestId !== hydrationRequestRef.current) return;
      if (reason instanceof UnsupportedWorkspaceLayoutVersionError) {
        setHydrationError(toAppErrorState(reason));
        patchHost({ hydrationStatus: "needsReset" }, "hydrate:needsReset");
        return;
      }
      setHydrationError(toAppErrorState(reason));
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
      setLayoutResetError(toAppErrorState(reason));
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
      semanticsOf: (directoryId) =>
        deps.getPathSemantics?.(directoryId) ?? UNKNOWN_PATH_SEMANTICS,
      protectedDocumentIds: new Set([
        ...currentDocuments
          .filter((document) =>
            hasUnsavedWorkspaceFileEdits(store.getLive().buffers[document.id]),
          )
          .map((document) => document.id),
        ...fileDocumentIdsOf(protectedContents),
      ]),
    });

    // 命令内部再次做陈旧检查，通过后才登记 coordinator 并提交；被拒绝时树、槽位与 coordinator 都不变。
    const outcome = deps.execute({
      type: "applyPreset",
      expected: expectedState,
      next: {
        tree: computed.restoredTree,
        slots: computed.restoredSlots,
        documents: computed.nextDocuments,
        focusedPaneId: computed.focusedPaneId,
      },
    });
    if (outcome.status === "ignored") {
      throw new Error(deps.translate("pty.layoutChangedDuringApply"));
    }
    // 提交之后再释放被丢弃的文件文档：只释放已不在新文档集合中的编辑资源（2.1 节记录的顺序差异）。
    deps.releaseDocuments(
      droppedFileDocumentIds(currentDocuments, computed.nextDocuments),
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

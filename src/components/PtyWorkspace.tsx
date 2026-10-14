import {
  createContentWindowOrchestrator,
  latestContentWindowDeps,
  type ContentWindowDeps,
} from "../workspace/windows/contentWindowOrchestrator";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useDirectories } from "../hooks/queries";

import {
  type WorkspaceNode,
  createWorkspacePane,
  findWorkspacePane,
  listWorkspacePanes,
  listWorkspacePaneContents,
  hasWorkspaceContent,
  remapWorkspaceFileIds,
  setWorkspaceSplitRatio,
  type SplitDirection,
} from "../lib/ptyWorkspaceLayout";

import { LISTENER_REGISTRATION_RETRY_DELAYS_MS } from "../lib/workspaceContentListenerSetup";
import { type IsolatedRegistrationFailure } from "../lib/retryPolicy";

import {
  getWorkspaceLayout,
  planApplyWorkspaceLayoutPreset,
  resetWorkspaceLayout,
  saveWorkspaceLayout,
  type Directory,
  type PtySession,
  type ToolKey,
  type WorkspaceLayoutSlot,
  type WorkspacePaneContentRef,
} from "../lib/tauri";
import {
  createWorkspaceLayoutDocument,
  isWorkspaceApplyStateCurrent,
  markWorkspaceSlotsRestored,
  removeEndedWorkspaceSlots,
  rehomeDetachedWorkspaceContents,
  restoreCurrentWorkspaceFilesAfterPreset,
  restoreWorkspaceLayoutApplyPlan,
  restoreWorkspaceRuntimeSnapshot,
  UnsupportedWorkspaceLayoutVersionError,
  WorkspaceLayoutSaveQueue,
  listPersistedDetachedContents,
} from "../lib/workspaceLayoutPersistence";
import {
  isHandoffActive,
  isWindowOwned,
} from "../lib/workspaceOwnershipProjection";
import { isWorkspaceFileBufferNewer } from "../lib/workspaceFileBuffer";
import { formatAppError } from "../lib/appErrors";
import { collectAppExitImpacts } from "../lib/appExitImpacts";
import { WorkspaceContentCoordinator } from "../lib/workspaceContentCoordinator";
import {
  fileContentKey,
  ptyContentKey,
  workspaceContentKey,
} from "../lib/workspaceContentKey";

import { hasWorkspaceDataRestoreBlockers } from "../lib/workspaceRestorePolicy";

import { useAppStore } from "../store/appStore";
import { createFileDocumentsDomain } from "../workspace/domains/fileDocumentsDomain";
import { createPtySlotsDomain } from "../workspace/domains/ptySlotsDomain";
import { createWorkspaceCommandExecutor } from "../workspace/host/workspaceCommandExecutor";
import {
  PtyWorkspaceContext,
  WorkspaceCommandsContext,
  usePtyWorkspace,
  type PtyWorkspaceContextValue,
  type SplitResizePhase,
  type WorkspaceCommands,
} from "../workspace/host/workspaceContexts";

import {
  createContentWindowProtocol,
  useContentWindowProtocol,
} from "../workspace/windows/useContentWindowProtocol";
import {
  createFileProtocolHandlers,
  requestFileWindowFlush,
} from "../workspace/windows/protocolHandlers.file";
import { createPtyProtocolHandlers } from "../workspace/windows/protocolHandlers.pty";
import { ImpactConfirmDialog } from "../workspace/views/ImpactConfirmDialog";
import { createFileContentDomain } from "../workspace/domains/fileContentDomain";
import { createPtyContentDomain } from "../workspace/domains/ptyContentDomain";
import {
  createWorkspaceDomainTable,
  getWorkspaceDomain,
  workspaceDomainKinds,
} from "../workspace/domains/workspaceDomainTable";
import { collectWorkspaceImpacts } from "../workspace/impacts/workspaceImpacts";
import { resetHostRuntime } from "../workspace/host/resetHostRuntime";
import {
  WorkspaceHostStore,
  WorkspaceHostStoreContext,
  createInitialHostSnapshot,
  type HostSnapshot,
} from "../workspace/host/workspaceHostStore";
import {
  presentWorkspaceContent,
  tryGetWorkspaceContentAdapter,
  workspaceContentProjectContext,
  type WorkspaceContentPresentationContext,
} from "./WorkspaceContentView";
import { reduceWorkspaceTree } from "../lib/workspaceContentCommand";
import {
  closeWorkspaceContentBatch,
  disposeWorkspaceContent,
  shouldCloseWorkspaceContent,
  type WorkspaceContentDisposalImpact,
} from "../lib/workspaceContentClose";

import {
  WorkspacePtySessionRegistry,
  type PtyWorkspaceSlot,
} from "./WorkspacePtySessionRegistry";
import { droppedFileDocumentIds } from "../lib/workspaceFileDocumentRelease";
import { reportWindowSyncFailure } from "../lib/windowSyncDiagnostics";
import "allotment/dist/style.css";

export { usePtyWorkspace };
export {
  WorkspaceRegion as PtyWorkspaceRegion,
  WorkspaceLayoutControls,
} from "../workspace/views/WorkspaceRegion";

/**
 * @param coordinator 仅测试注入：宿主 harness 用它观察与断言内容归属状态。
 * 生产代码（`App.tsx`）不传该属性，行为与注入前完全一致。
 */
export function PtyWorkspaceProvider({
  children,
  coordinator,
  listenerRetryDelaysMs,
}: {
  children: ReactNode;
  coordinator?: WorkspaceContentCoordinator;
  /** 仅测试注入：监听注册的重试间隔（默认 [100, 300]）。 */
  listenerRetryDelaysMs?: readonly number[];
}) {
  const { t } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;
  const listenerRetryDelaysRef = useRef(
    listenerRetryDelaysMs ?? LISTENER_REGISTRATION_RETRY_DELAYS_MS,
  );
  const reportListenerSetupFailure = useCallback(
    (group: string, failed: IsolatedRegistrationFailure[]) => {
      console.error(`Workspace ${group} listener setup failed`, failed);
      toast.error(
        tRef.current("pty.listenerSetupFailed", {
          events: failed.map((item) => item.name).join(", "),
        }),
      );
    },
    [],
  );
  const { data: directories } = useDirectories();
  const [hydrationError, setHydrationError] = useState<string | null>(null);
  const [layoutSaveError, setLayoutSaveError] = useState<string | null>(null);
  const [layoutResetError, setLayoutResetError] = useState<string | null>(null);
  const [layoutResetPending, setLayoutResetPending] = useState(false);
  const [closeConfirmationImpacts, setCloseConfirmationImpacts] = useState<
    WorkspaceContentDisposalImpact[] | null
  >(null);
  const closeConfirmationResolverRef = useRef<
    ((confirmed: boolean) => void) | null
  >(null);
  const [initialPaneId] = useState<string>(() => crypto.randomUUID());
  // 惰性初始化：StrictMode 下只保留第一次构造的 store（useRef 的初始值会被丢弃）。
  const [store] = useState(
    () => new WorkspaceHostStore(createInitialHostSnapshot(initialPaneId)),
  );
  // 对象式写入的薄包装，内部仍只调用 store.commit（唯一写入口）。
  const patchHost = useCallback(
    (patch: Partial<HostSnapshot>, reason: string) =>
      store.commit((live) => ({ ...live, ...patch }), reason),
    [store],
  );
  // 宿主状态的唯一来源是 store 的已发布快照；写入只经 store.commit。
  const {
    tree,
    treeRevision: workspaceTreeRevision,
    focusedPaneId,
    slots,
    documents: fileDocuments,
    buffers: fileBuffers,
    hydrationStatus,
  } = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const [portalTargets, setPortalTargets] = useState<
    Record<string, HTMLDivElement>
  >({});
  const [ptyDomain] = useState(() => createPtySlotsDomain());
  const terminalRefs = ptyDomain.terminalRefs;
  const saveQueueRef = useRef<WorkspaceLayoutSaveQueue | null>(null);
  const backupRestoreInProgressRef = useRef(false);
  const hydrationRequestRef = useRef(0);
  const ratioSaveTimerRef = useRef<number | null>(null);
  const splitResizeInProgressRef = useRef(false);
  const persistLatestRef = useRef<(() => void) | null>(null);
  const contentCoordinatorRef = useRef(
    coordinator ?? new WorkspaceContentCoordinator(),
  );
  // 窗口编排：句柄表、pending 表与返回等待中止器由 orchestrator 持有；依赖经 depsRef 读取最新值（R-FE-1）。
  const depsRef = useRef<ContentWindowDeps | null>(null);
  const [orchestrator] = useState(() =>
    createContentWindowOrchestrator(latestContentWindowDeps(depsRef)),
  );
  // 文件领域：文件文档与缓冲的加载、编辑、保存、关闭经由领域对象完成（惰性初始化，闭包按调用时读取 ref）。
  const [fileDomain] = useState(() =>
    createFileDocumentsDomain(store, {
      isRestoreInProgress: () => backupRestoreInProgressRef.current,
      getHydrationEpoch: () => hydrationRequestRef.current,
      isHandoffActive: (documentId) =>
        isHandoffActive(
          contentCoordinatorRef.current.get({ kind: "file", documentId }),
        ),
      getTranslate: () => tRef.current,
      notify: {
        error: (message, options) => toast.error(message, options),
        warning: (message) => toast.warning(message),
      },
    }),
  );
  useEffect(() => () => orchestrator.abortReturnWait(), [orchestrator]);
  const subscribeContentCoordinator = useCallback(
    (listener: () => void) => contentCoordinatorRef.current.subscribe(listener),
    [],
  );
  const getContentCoordinatorRevision = useCallback(
    () => contentCoordinatorRef.current.getRevision(),
    [],
  );
  const contentCoordinatorRevision = useSyncExternalStore(
    subscribeContentCoordinator,
    getContentCoordinatorRevision,
    getContentCoordinatorRevision,
  );
  const detachedWindowContents = useMemo(
    () => contentCoordinatorRef.current.listWindowOwned(),
    [contentCoordinatorRevision],
  );
  const detachedFileIds = useMemo(
    () =>
      new Set(
        detachedWindowContents.flatMap((content) =>
          content.kind === "file" ? [content.documentId] : [],
        ),
      ),
    [detachedWindowContents],
  );
  const detachedInstanceIds = useMemo(
    () =>
      new Set(
        detachedWindowContents.flatMap((content) =>
          content.kind === "pty" ? [content.slotId] : [],
        ),
      ),
    [detachedWindowContents],
  );
  const handoffFileIds = useMemo(
    () =>
      new Set(
        contentCoordinatorRef.current
          .listInPhases("detaching", "returning")
          .flatMap((content) =>
            content.kind === "file" ? [content.documentId] : [],
          ),
      ),
    [contentCoordinatorRevision],
  );
  const closingContentKeys = useMemo(
    () =>
      new Set(
        contentCoordinatorRef.current
          .listInPhases("closing")
          .filter((content) => content.kind === "pty")
          .map(workspaceContentKey),
      ),
    [contentCoordinatorRevision],
  );
  const activeView = useAppStore((state) => state.view);

  const createSaveQueue = useCallback(
    (revision: number) =>
      new WorkspaceLayoutSaveQueue(
        revision,
        saveWorkspaceLayout,
        (reason) => setLayoutSaveError(formatAppError(reason, tRef.current)),
        () => setLayoutSaveError(null),
      ),
    [],
  );

  const persistWorkspaceSnapshot = useCallback(
    (treeOverride?: WorkspaceNode) => {
      if (store.getLive().hydrationStatus !== "ready") return;
      if (backupRestoreInProgressRef.current) return;
      const queue = saveQueueRef.current;
      if (!queue) return;

      const snapshotTree = treeOverride ?? store.getLive().tree;
      // 快照构造不得把异常抛进 effect：根边界只能兜底成重载提示（丢失未保存缓冲），
      // 所以这里降级为一次可自愈的保存错误，下一次状态变化会重新保存。
      try {
        const persistedSlots: WorkspaceLayoutSlot[] = store
          .getLive()
          .slots.map((slot) => toWorkspaceLayoutSlot(slot, directories ?? []));
        queue.enqueue(
          createWorkspaceLayoutDocument({
            tree: snapshotTree,
            focusedPaneId: store.getLive().focusedPaneId,
            slots: persistedSlots,
            documents: store.getLive().documents,
            detachedContents: listPersistedDetachedContents(
              contentCoordinatorRef.current.listWindowOwned(),
              snapshotTree,
            ),
          }),
        );
      } catch (reason) {
        setLayoutSaveError(formatAppError(reason, tRef.current));
        console.error("[workspace.layout_snapshot_invalid]", reason);
      }
    },
    [directories],
  );

  persistLatestRef.current = () => persistWorkspaceSnapshot();

  const releaseFileDocuments = useCallback((documentIds: readonly string[]) => {
    if (documentIds.length === 0) return;
    const dispose = tryGetWorkspaceContentAdapter("file")?.lifecycle?.dispose;
    if (!dispose) return;
    for (const documentId of documentIds) {
      void (async () => {
        try {
          await dispose({
            content: { kind: "file", documentId },
            owner: { kind: "window", windowLabel: "main" },
            generation: 0,
            reason: "ownerEnded",
          });
        } catch (error) {
          console.error("Workspace file document release failed", error);
        }
      })();
    }
  }, []);

  const hydrateWorkspace = useCallback(async () => {
    const requestId = ++hydrationRequestRef.current;
    patchHost({ hydrationStatus: "loading" }, "hydrate:loading");
    setHydrationError(null);
    setLayoutResetError(null);
    saveQueueRef.current = null;

    try {
      const read = await getWorkspaceLayout();
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
          throw new Error(tRef.current("pty.layoutDataMissing"));
        }
        const restored = rehomeDetachedWorkspaceContents(
          restoreWorkspaceRuntimeSnapshot(read.layout),
        );
        const restoredSnapshot = removeEndedWorkspaceSlots({
          ...restored,
          slots: markWorkspaceSlotsRestored(restored.slots, read.slotStates),
        });
        const restoredSlots: PtyWorkspaceSlot[] = restoredSnapshot.slots;
        // 协调器重建失败时与原实现一致：执行完其余步骤后进入 loadFailed，不发布半更新的状态。
        const rebuild: { failed: boolean; error: unknown } = {
          failed: false,
          error: undefined,
        };
        resetHostRuntime("hydrate", {
          rollbackPending: orchestrator.rollbackPending,
          forgetWindowHandles: orchestrator.forgetHandles,
          releaseDocuments: () => {
            // 释放旧文档必须读取提交前的文档集合，因此在发布新状态之前执行。
            releaseFileDocuments(
              droppedFileDocumentIds(
                store.getLive().documents,
                restoredSnapshot.documents ?? [],
              ),
            );
            fileDomain.invalidateLoads(
              new Set([
                ...store.getLive().documents.map((document) => document.id),
                ...(restoredSnapshot.documents ?? []).map(
                  (document) => document.id,
                ),
              ]),
            );
          },
          clearPtyRuntime: () => undefined,
          rebuildCoordinator: () => {
            try {
              contentCoordinatorRef.current.resetFromPanes(
                listWorkspacePanes(restoredSnapshot.tree),
                "main",
              );
            } catch (error) {
              rebuild.failed = true;
              rebuild.error = error;
            }
          },
        });
        if (rebuild.failed) throw rebuild.error;
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
      setHydrationError(formatAppError(reason, tRef.current));
      patchHost({ hydrationStatus: "loadFailed" }, "hydrate:loadFailed");
    }
  }, [createSaveQueue, releaseFileDocuments, store]);

  useEffect(() => {
    void hydrateWorkspace();
    return () => {
      hydrationRequestRef.current += 1;
      orchestrator.disposeAll();
    };
  }, [hydrateWorkspace]);

  useEffect(() => {
    if (hydrationStatus === "ready") persistWorkspaceSnapshot();
  }, [
    detachedInstanceIds,
    focusedPaneId,
    hydrationStatus,
    persistWorkspaceSnapshot,
    slots,
    fileDocuments,
    tree,
  ]);

  useEffect(
    () => () => {
      if (ratioSaveTimerRef.current !== null) {
        window.clearTimeout(ratioSaveTimerRef.current);
      }
      if (store.getLive().hydrationStatus === "ready") {
        persistLatestRef.current?.();
        const queue = saveQueueRef.current;
        void queue?.flush();
        queue?.dispose();
      }
    },
    [],
  );

  const retryHydration = useCallback(() => {
    void hydrateWorkspace();
  }, [hydrateWorkspace]);

  const resetWorkspace = useCallback(async () => {
    if (store.getLive().hydrationStatus !== "needsReset") return;
    setLayoutResetPending(true);
    setLayoutResetError(null);
    try {
      const revision = await resetWorkspaceLayout();
      saveQueueRef.current = createSaveQueue(revision);
      setHydrationError(null);
      setLayoutSaveError(null);
      patchHost({ hydrationStatus: "ready" }, "resetWorkspace:ready");
    } catch (reason) {
      setLayoutResetError(formatAppError(reason, tRef.current));
      throw reason;
    } finally {
      setLayoutResetPending(false);
    }
  }, [createSaveQueue]);

  const applyWorkspaceLayoutPreset = useCallback(
    async (presetId: string) => {
      if (store.getLive().hydrationStatus !== "ready") return;
      const protectedContents = contentCoordinatorRef.current.listWindowOwned();
      const expectedState = {
        tree: store.getLive().tree,
        slots: store.getLive().slots,
        focusedPaneId: store.getLive().focusedPaneId,
        detachedContents: protectedContents,
      };
      let activeTree = expectedState.tree;
      const detachedContents =
        contentCoordinatorRef.current.listInPhases("detached");
      for (const content of detachedContents) {
        activeTree = reduceWorkspaceTree(activeTree, {
          type: "detach",
          ref: content,
        });
      }
      const activePanes = listWorkspacePanes(activeTree);
      const activeLayout = createWorkspaceLayoutDocument({
        tree: activeTree,
        focusedPaneId: activePanes.some(
          (pane) => pane.id === store.getLive().focusedPaneId,
        )
          ? store.getLive().focusedPaneId
          : activePanes[0].id,
        slots: store
          .getLive()
          .slots.map((slot) => toWorkspaceLayoutSlot(slot, directories ?? [])),
        documents: store.getLive().documents,
        detachedContents: listPersistedDetachedContents(
          contentCoordinatorRef.current.listWindowOwned(),
          activeTree,
        ),
      });
      const plan = await planApplyWorkspaceLayoutPreset(presetId, activeLayout);
      if (
        !isWorkspaceApplyStateCurrent(expectedState, {
          tree: store.getLive().tree,
          slots: store.getLive().slots,
          focusedPaneId: store.getLive().focusedPaneId,
          detachedContents: contentCoordinatorRef.current.listWindowOwned(),
        })
      ) {
        throw new Error(tRef.current("pty.layoutChangedDuringApply"));
      }
      const restored = restoreWorkspaceLayoutApplyPlan(plan);
      const restoredSlots: PtyWorkspaceSlot[] = restored.slots;
      const restoredDocuments = [...(restored.documents ?? [])];
      const currentDocuments = store.getLive().documents;
      const currentDocumentByIdentity = new Map(
        currentDocuments.map((document) => [
          `${document.directoryId}:${document.relativePath}`,
          document,
        ]),
      );
      fileDomain.invalidateLoads(
        new Set([
          ...currentDocuments.map((document) => document.id),
          ...restoredDocuments.map((document) => document.id),
        ]),
      );
      const documentIdMap = new Map<string, string>();
      const normalizedDocuments = restoredDocuments.map((document) => {
        const currentDocument = currentDocumentByIdentity.get(
          `${document.directoryId}:${document.relativePath}`,
        );
        if (!currentDocument) return document;
        documentIdMap.set(document.id, currentDocument.id);
        return currentDocument;
      });
      let restoredTree = remapWorkspaceFileIds(restored.tree, documentIdMap);
      restoredDocuments.splice(
        0,
        restoredDocuments.length,
        ...normalizedDocuments,
      );
      const detachedNow =
        contentCoordinatorRef.current.listInPhases("detached");
      const detachingNow =
        contentCoordinatorRef.current.listInPhases("detaching");
      const restoredFiles = restoreCurrentWorkspaceFilesAfterPreset({
        tree: restoredTree,
        focusedPaneId: restored.focusedPaneId,
        restoredDocuments,
        currentDocuments,
        detachedContents: restored.detachedContents,
        currentlyDetachedContents: detachedNow,
        detachingContents: detachingNow,
      });
      restoredTree = restoredFiles.tree;
      const nextDocuments = restoredFiles.documents;

      // 必须在上面的状态一致性检查之后登记，否则检查失败时 coordinator 已被污染。
      for (const pane of listWorkspacePanes(restoredTree)) {
        for (const content of pane.contents) {
          if (content.kind === "unknown") continue;
          contentCoordinatorRef.current.ensureAttached(content, {
            kind: "pane",
            windowLabel: "main",
            paneId: pane.id,
          });
        }
      }

      releaseFileDocuments(
        droppedFileDocumentIds(currentDocuments, nextDocuments),
      );
      patchHost(
        {
          slots: restoredSlots,
          documents: nextDocuments,
          tree: restoredTree,
          focusedPaneId: restored.focusedPaneId,
        },
        "applyWorkspaceLayoutPreset:apply",
      );
    },
    [directories, releaseFileDocuments, store],
  );

  const commitTree = useCallback(
    (next: WorkspaceNode) => patchHost({ tree: next }, "commitTree"),
    [patchHost],
  );

  const setFocusedPane = useCallback(
    (paneId: string) => patchHost({ focusedPaneId: paneId }, "setFocusedPane"),
    [patchHost],
  );

  const getWorkspacePresentationContext = useCallback(
    (): WorkspaceContentPresentationContext => ({
      directories: directories ?? [],
      ptySlots: store.getLive().slots,
      ptySessionsById: store.getLive().ptySessionsById,
      fileDocuments: store.getLive().documents,
      fileBuffers: store.getLive().buffers,
      selectedDirectoryId: useAppStore.getState().selectedDirectoryId,
    }),
    [directories],
  );

  const syncProjectContext = useCallback(
    (content: WorkspacePaneContentRef) => {
      const directoryId = workspaceContentProjectContext(
        content,
        getWorkspacePresentationContext(),
      );
      if (directoryId === null) return;
      const state = useAppStore.getState();
      if (
        state.view !== "detail" ||
        state.selectedDirectoryId !== directoryId
      ) {
        state.openDirectory(directoryId);
      }
    },
    [getWorkspacePresentationContext],
  );

  const syncProjectContextRef = useRef(syncProjectContext);
  syncProjectContextRef.current = syncProjectContext;
  const [executor] = useState(() =>
    createWorkspaceCommandExecutor({
      store,
      coordinator: contentCoordinatorRef.current,
      addSlot: ptyDomain.addSlot,
      isRestoreInProgress: () => backupRestoreInProgressRef.current,
      afterCommit: (ref) => syncProjectContextRef.current(ref),
      newId: () => crypto.randomUUID(),
    }),
  );

  const openProjectFile = useCallback(
    (
      directoryId: number,
      directoryPath: string,
      relativePath: string,
    ): Promise<void> =>
      fileDomain.open(
        { directoryId, directoryPath, relativePath },
        async (document) => {
          const detachedWindow =
            orchestrator.state.handles.file.get(fileContentKey(document.id)) ??
            orchestrator.state.pending.file.get(fileContentKey(document.id))
              ?.window;
          if (detachedWindow) {
            await detachedWindow
              .setFocus()
              .catch((error: unknown) =>
                reportWindowSyncFailure(
                  "window.set_focus_failed",
                  error,
                  "无法聚焦独立工作区窗口",
                ),
              );
            return;
          }

          executor.execute({
            type: "place",
            ref: { kind: "file", documentId: document.id },
          });
        },
      ),
    [executor, fileDomain],
  );

  const activateFile = useCallback(
    (paneId: string, documentId: string) => {
      executor.execute({
        type: "activate",
        ref: { kind: "file", documentId },
        paneId,
      });
    },
    [executor],
  );

  const activateUnsupportedContent = useCallback(
    (
      paneId: string,
      content: Extract<WorkspacePaneContentRef, { kind: "unknown" }>,
    ) => {
      executor.execute({ type: "activate", ref: content, paneId });
    },
    [executor],
  );

  const loadFile = fileDomain.load;
  const editFile = fileDomain.edit;
  const saveFile = fileDomain.save;

  const registerPortalTarget = useCallback(
    (instanceId: string, target: HTMLDivElement | null) => {
      setPortalTargets((current) => {
        if (target) {
          if (current[instanceId] === target) return current;
          return { ...current, [instanceId]: target };
        }
        if (!current[instanceId]) return current;
        const next = { ...current };
        delete next[instanceId];
        return next;
      });
    },
    [],
  );

  const focusPane = useCallback(
    (paneId: string) => {
      executor.execute({ type: "focus", paneId });
    },
    [executor],
  );

  const removeSlot = useCallback(
    (instanceId: string, options: { disposeOwnerEnded?: boolean } = {}) => {
      const content = { kind: "pty", slotId: instanceId } as const;
      if (options.disposeOwnerEnded !== false) {
        void disposeWorkspaceContent({
          coordinator: contentCoordinatorRef.current,
          content,
          reason: "ownerEnded",
          dispose: tryGetWorkspaceContentAdapter("pty")?.lifecycle?.dispose,
        });
      }
      orchestrator.state.handles.pty.delete(ptyContentKey(instanceId));
      // 槽位移除与树关闭在同一次提交中发布。
      const liveTree = store.getLive().tree;
      store.commit((live) => {
        const result = ptyDomain.removeSlot(live, instanceId);
        const nextTree = reduceWorkspaceTree(liveTree, {
          type: "close",
          refs: [content],
          origin: "window",
        });
        const focusedPaneId = findWorkspacePane(
          nextTree,
          result.next.focusedPaneId,
        )
          ? result.next.focusedPaneId
          : listWorkspacePanes(nextTree)[0].id;
        return { ...result.next, tree: nextTree, focusedPaneId };
      }, "removeSlot");
    },
    [ptyDomain, store],
  );

  const confirmCloseImpacts = useCallback(
    (impacts: WorkspaceContentDisposalImpact[]) =>
      new Promise<boolean>((resolve) => {
        if (closeConfirmationResolverRef.current) {
          resolve(false);
          return;
        }
        closeConfirmationResolverRef.current = resolve;
        setCloseConfirmationImpacts(impacts);
      }),
    [],
  );

  const resolveCloseConfirmation = useCallback((confirmed: boolean) => {
    const resolve = closeConfirmationResolverRef.current;
    closeConfirmationResolverRef.current = null;
    setCloseConfirmationImpacts(null);
    resolve?.(confirmed);
  }, []);

  // 领域操作注入表：宿主只通过 domainTable[kind] 访问内容类型的关闭行为（file 在前、pty 在后，即关闭顺序）。
  const domainTable = useMemo(
    () =>
      createWorkspaceDomainTable({
        file: createFileContentDomain({
          store,
          fileDomain,
          isWindowOwned: (ref) =>
            isWindowOwned(contentCoordinatorRef.current.get(ref)),
          isHandoffActive: (ref) =>
            isHandoffActive(contentCoordinatorRef.current.get(ref)),
        }),
        pty: createPtyContentDomain({
          store,
          terminalRefs: ptyDomain.terminalRefs,
          isWindowOwned: (ref) =>
            isWindowOwned(contentCoordinatorRef.current.get(ref)),
          titleOf: (ref) =>
            presentWorkspaceContent(ref, getWorkspacePresentationContext())
              .title,
          removeSlot: (instanceId, options) => removeSlot(instanceId, options),
        }),
      }),
    [store, fileDomain, ptyDomain, removeSlot, getWorkspacePresentationContext],
  );
  // 窗口编排的依赖经 depsRef 写入，每次渲染更新（与 tRef 同款写法）。
  depsRef.current = {
    store,
    getCoordinator: () => contentCoordinatorRef.current,
    translate: tRef.current,
    commitTree,
    setFocusedPane,
    removeSlot,
    loadFile,
    waitForFileSave: (documentId) => fileDomain.waitForSave(documentId),
    mergeFileBuffers: (entries, reason) =>
      fileDomain.mergeBuffers(entries, reason),
    terminalOf: (instanceId) => terminalRefs.current.get(instanceId),
    titleOfPty: (instanceId) =>
      presentWorkspaceContent(
        { kind: "pty", slotId: instanceId },
        getWorkspacePresentationContext(),
      ).title,
    openDirectory: (directoryId) =>
      useAppStore.getState().openDirectory(directoryId),
  };

  const closeContents = useCallback(
    async (
      requestedContents: WorkspacePaneContentRef[],
      origin: "tab" | "menu" | "stack" | "window",
      onApproved?: () => void,
    ) => {
      const uniqueContents: WorkspacePaneContentRef[] = [
        ...new Map(
          requestedContents.map((content) => [
            workspaceContentKey(content),
            content,
          ]),
        ).values(),
      ];
      type WorkspaceCloseTarget = {
        content: WorkspacePaneContentRef;
        beforeClose: () => boolean;
        describeDisposalImpact: () => WorkspaceContentDisposalImpact[];
      };
      const closeTargets: WorkspaceCloseTarget[] = [];
      for (const content of uniqueContents) {
        const pane = listWorkspacePanes(store.getLive().tree).find(
          (candidate) => hasWorkspaceContent(candidate, content),
        );
        if (!pane) continue;

        if (content.kind === "unknown") {
          closeTargets.push({
            content,
            beforeClose: () => true,
            describeDisposalImpact: () => [],
          });
          continue;
        }

        const domain = getWorkspaceDomain(domainTable, content.kind);
        const input = domain?.closeInput(content);
        if (!domain || !input) continue;
        const adapter = tryGetWorkspaceContentAdapter(content.kind);
        contentCoordinatorRef.current.ensureAttached(content, {
          kind: "pane",
          windowLabel: "main",
          paneId: pane.id,
        });
        closeTargets.push({
          content,
          beforeClose: () =>
            shouldCloseWorkspaceContent(adapter?.lifecycle?.beforeClose, {
              isDirty: input.isDirty,
              confirmDiscard: () => false,
            }),
          describeDisposalImpact: () =>
            collectWorkspaceImpacts({ sources: [{ input, adapter }] }),
        });
      }
      if (closeTargets.length === 0) return;

      let pendingCount = 0;
      let failedCount = 0;
      try {
        await closeWorkspaceContentBatch({
          coordinator: contentCoordinatorRef.current,
          requestId: crypto.randomUUID(),
          requests: closeTargets,
          confirmImpacts: confirmCloseImpacts,
          onApproved,
          dispose: (context) => {
            if (context.content.kind === "unknown") return;
            return tryGetWorkspaceContentAdapter(
              context.content.kind,
            )?.lifecycle?.dispose?.(context as never);
          },
          execute: async () => {
            const closedContents: WorkspacePaneContentRef[] = [];
            const pendingContents: WorkspacePaneContentRef[] = [];
            const unsupportedContents = closeTargets.flatMap((target) =>
              target.content.kind === "unknown" ? [target.content] : [],
            );
            if (unsupportedContents.length > 0) {
              commitTree(
                unsupportedContents.reduce(
                  (next, content) =>
                    reduceWorkspaceTree(next, {
                      type: "close",
                      refs: [content],
                      origin,
                    }),
                  store.getLive().tree,
                ),
              );
              closedContents.push(...unsupportedContents);
            }
            for (const kind of workspaceDomainKinds(domainTable)) {
              const refs = closeTargets.flatMap((target) =>
                target.content.kind === kind ? [target.content] : [],
              );
              if (refs.length === 0) continue;
              const result = await domainTable[kind].close(
                refs as never,
                origin,
              );
              closedContents.push(...result.closed);
              pendingContents.push(...result.pending);
              failedCount += result.failed.length;
            }
            pendingCount += pendingContents.length;
            return { closed: closedContents, pending: pendingContents };
          },
        });
      } catch (reason) {
        console.error(
          `Failed to close workspace contents from ${origin}`,
          reason,
        );
      }

      if (pendingCount > 0) {
        toast.info(tRef.current("pty.closePending", { count: pendingCount }));
      }
      if (failedCount > 0) {
        toast.error(
          tRef.current("pty.closeFailedMany", { count: failedCount }),
        );
      }
    },
    [commitTree, confirmCloseImpacts, domainTable, store],
  );

  const launchSession = useCallback(
    (directoryId: number, toolKey: ToolKey, resumeSessionId?: string) => {
      if (backupRestoreInProgressRef.current) return;
      const directory = directories?.find((entry) => entry.id === directoryId);
      if (!directory) {
        toast.error(tRef.current("pty.projectUnavailable"));
        return;
      }
      const slot = ptyDomain.createSlot(
        store.getLive().slots,
        { id: directoryId, path: directory.path, name: directory.name },
        toolKey,
        resumeSessionId,
      );
      executor.execute({ type: "launch", slot });
    },
    [directories, executor, ptyDomain, store],
  );

  const activateSession = useCallback(
    (paneId: string, instanceId: string) => {
      try {
        executor.execute({
          type: "activate",
          ref: { kind: "pty", slotId: instanceId },
          paneId,
        });
      } catch {
        return;
      }
    },
    [executor],
  );

  const splitPane = useCallback(
    (paneId: string, direction: SplitDirection) => {
      executor.execute({ type: "splitPane", paneId, direction });
    },
    [executor],
  );

  const splitAndMoveContent = useCallback(
    (
      paneId: string,
      content: WorkspacePaneContentRef,
      direction: SplitDirection,
    ) => {
      executor.execute({
        type: "split",
        ref: content,
        fromPaneId: paneId,
        direction,
      });
    },
    [executor],
  );

  const splitAndMoveSession = useCallback(
    (paneId: string, instanceId: string, direction: SplitDirection) =>
      splitAndMoveContent(
        paneId,
        { kind: "pty", slotId: instanceId },
        direction,
      ),
    [splitAndMoveContent],
  );

  const splitAndMoveFile = useCallback(
    (paneId: string, documentId: string, direction: SplitDirection) =>
      splitAndMoveContent(paneId, { kind: "file", documentId }, direction),
    [splitAndMoveContent],
  );

  const moveContent = useCallback(
    (
      sourcePaneId: string,
      destinationPaneId: string,
      content: WorkspacePaneContentRef,
    ) => {
      executor.execute({
        type: "move",
        ref: content,
        fromPaneId: sourcePaneId,
        toPaneId: destinationPaneId,
      });
    },
    [executor],
  );

  const moveSession = useCallback(
    (sourcePaneId: string, destinationPaneId: string, instanceId: string) =>
      moveContent(sourcePaneId, destinationPaneId, {
        kind: "pty",
        slotId: instanceId,
      }),
    [moveContent],
  );

  const moveFile = useCallback(
    (sourcePaneId: string, destinationPaneId: string, documentId: string) =>
      moveContent(sourcePaneId, destinationPaneId, {
        kind: "file",
        documentId,
      }),
    [moveContent],
  );

  // 文件独立窗被销毁（崩溃或被强制关闭）后，Rust 通知主窗口：只回收 coordinator 认为
  // “由该窗口持有（detached）”的文件。正常返回/关闭之后窗口同样会触发 Destroyed，
  // 此时状态已不是 detached，函数直接返回。顺序固定：ownerEnded → 删句柄 → ensureAttached
  // → 一次 commitTree；镜像到主窗口的 buffer 原样保留，不读盘、不弹提示。

  // 独立窗口协议监听：三组监听由 useContentWindowProtocol 统一注册一次（依赖只有稳定的 protocol）。
  const [protocol] = useState(() =>
    createContentWindowProtocol({
      pty: createPtyProtocolHandlers(orchestrator),
      file: createFileProtocolHandlers(orchestrator),
      shell: {
        retryDelaysMs: listenerRetryDelaysRef.current,
        onFailed: reportListenerSetupFailure,
      },
    }),
  );
  useContentWindowProtocol(protocol);

  const closeEmptyPane = useCallback(
    (paneId: string) => {
      executor.execute({ type: "closeEmptyPane", paneId });
    },
    [executor],
  );

  const updateSplitRatio = useCallback(
    (splitId: string, sizes: number[], phase: SplitResizePhase) => {
      const total = sizes.reduce((sum, size) => sum + size, 0);
      if (sizes.length !== 2 || total <= 0 || !Number.isFinite(total)) return;

      const nextTree = setWorkspaceSplitRatio(
        store.getLive().tree,
        splitId,
        sizes[0] / total,
      );
      // 拖拽过程只写未发布的临时树：getLive 可见，不发布、不通知。dragEnd 时再统一发布。
      if (phase !== "dragEnd") store.setTransientTree(nextTree);

      if (phase === "dragEnd") {
        splitResizeInProgressRef.current = false;
        if (ratioSaveTimerRef.current !== null) {
          window.clearTimeout(ratioSaveTimerRef.current);
          ratioSaveTimerRef.current = null;
        }
        commitTree(nextTree);
        return;
      }

      splitResizeInProgressRef.current = true;
      if (ratioSaveTimerRef.current === null) {
        ratioSaveTimerRef.current = window.setTimeout(() => {
          ratioSaveTimerRef.current = null;
          persistWorkspaceSnapshot();
        }, 500);
      }
    },
    [commitTree, persistWorkspaceSnapshot],
  );

  const recordSession = useCallback(
    (instanceId: string, session: PtySession | null) => {
      if (!session) return;
      if (session.state === "exited" || session.state === "terminated") {
        removeSlot(instanceId);
        return;
      }
      store.commit(
        (live) => ptyDomain.recordSession(live, instanceId, session),
        "recordSession",
      );
    },
    [removeSlot, ptyDomain, store],
  );

  const getCurrentPresetLayout = useCallback(() => {
    let presetTree = store.getLive().tree;
    const protectedContents = contentCoordinatorRef.current.listWindowOwned();
    for (const content of protectedContents) {
      presetTree = reduceWorkspaceTree(presetTree, {
        type: "detach",
        ref: content,
      });
    }
    const presetPanes = listWorkspacePanes(presetTree);
    const paneSlotIds = new Set(
      presetPanes.flatMap((pane) =>
        listWorkspacePaneContents(pane, "pty").flatMap((content) =>
          content.kind === "pty" ? [content.slotId] : [],
        ),
      ),
    );
    const paneFileIds = new Set(
      presetPanes.flatMap((pane) =>
        listWorkspacePaneContents(pane, "file").flatMap((content) =>
          content.kind === "file" ? [content.documentId] : [],
        ),
      ),
    );
    const currentFocusedPaneId = store.getLive().focusedPaneId;
    return createWorkspaceLayoutDocument({
      tree: presetTree,
      focusedPaneId: presetPanes.some(
        (pane) => pane.id === currentFocusedPaneId,
      )
        ? currentFocusedPaneId
        : presetPanes[0].id,
      slots: store
        .getLive()
        .slots.filter((slot) => paneSlotIds.has(slot.instanceId))
        .map((slot) => toWorkspaceLayoutSlot(slot, directories ?? [])),
      documents: store
        .getLive()
        .documents.filter((document) => paneFileIds.has(document.id)),
      detachedContents: [],
    });
  }, [directories]);

  const collectExitImpacts = useCallback(async (ptyCount: number) => {
    const managedWindows = new Map(
      orchestrator
        .listManagedFileWindows()
        .map((managed) => [managed.documentId, managed] as const),
    );

    const flushResults = await Promise.all(
      [...managedWindows.values()].map(async (managed) => ({
        managed,
        response: await requestFileWindowFlush(orchestrator, managed),
      })),
    );
    const uncertainDocumentIds: string[] = [];
    let nextBuffers = store.getLive().buffers;
    for (const { managed, response } of flushResults) {
      const currentDocument = store
        .getLive()
        .documents.find((document) => document.id === managed.documentId);
      if (
        !response ||
        !currentDocument ||
        response.fileDocument.directoryId !== currentDocument.directoryId ||
        response.fileDocument.directoryPath !== currentDocument.directoryPath ||
        response.fileDocument.relativePath !== currentDocument.relativePath
      ) {
        uncertainDocumentIds.push(managed.documentId);
        continue;
      }
      const currentBuffer = nextBuffers[managed.documentId];
      if (isWorkspaceFileBufferNewer(response.fileBuffer, currentBuffer)) {
        if (nextBuffers === store.getLive().buffers) {
          nextBuffers = { ...store.getLive().buffers };
        }
        nextBuffers[managed.documentId] = response.fileBuffer;
      }
    }
    if (nextBuffers !== store.getLive().buffers) {
      fileDomain.mergeBuffers(nextBuffers, "collectExitImpacts:buffers");
    }

    return collectAppExitImpacts({
      ptyCount,
      documents: store.getLive().documents,
      buffers: store.getLive().buffers,
      uncertainDocumentIds,
    });
  }, []);

  const getBackupRestoreBlockers = useCallback(async () => {
    backupRestoreInProgressRef.current = true;
    try {
      await fileDomain.waitForAllSaves();
      await saveQueueRef.current?.flush();

      const runningPtyCount = ptyDomain.runningSessions(store.getLive()).length;
      const impacts = await collectExitImpacts(runningPtyCount);
      const detachedWindowIdentities = new Set(
        contentCoordinatorRef.current
          .listWindowOwned()
          .map(workspaceContentKey),
      );

      const blockers = {
        runningPtyCount: impacts.ptyCount,
        dirtyFileCount: impacts.dirtyFiles.length,
        detachedWindowCount: detachedWindowIdentities.size,
      };
      if (hasWorkspaceDataRestoreBlockers(blockers)) {
        backupRestoreInProgressRef.current = false;
      }
      return blockers;
    } catch (reason) {
      backupRestoreInProgressRef.current = false;
      throw reason;
    }
  }, [collectExitImpacts]);

  const getDirectoryRemovalBlockers = useCallback((directoryId: number) => {
    return {
      openFileCount: store
        .getLive()
        .documents.filter((document) => document.directoryId === directoryId)
        .length,
      runningPtyCount: ptyDomain.runningCountIn(store.getLive(), directoryId),
    };
  }, []);

  const cancelBackupRestore = useCallback(() => {
    // 恢复请求成功时不在这里解冻：必须等 workspace-data-restored 触发
    // rehydrateWorkspace，否则旧内存布局会覆盖刚恢复的布局（FE-NEW-04）。
    // 失败路径使用 resumeAfterFailedRestore。
  }, []);

  const resumeAfterFailedRestore = useCallback(() => {
    // 只有在替换数据库之前失败（守卫拒绝、恢复前的错误）才会返回 Err，此时数据库
    // 内容未变，内存状态仍与之一致。这里只解除持久化冻结，不重新加载工作区：
    // rehydrate 会清空 PTY 会话表，恢复检查之后启动的运行中 PTY 会因此失去前端句柄。
    backupRestoreInProgressRef.current = false;
    // 冻结期间的变更只是被跳过、没有丢弃（状态保留），解冻后立即保存，
    // 否则在下一次状态变化前它们都不会落盘。
    persistLatestRef.current?.();
  }, []);

  const rehydrateWorkspace = useCallback(async () => {
    backupRestoreInProgressRef.current = false;
    resetHostRuntime("rehydrate", {
      rollbackPending: orchestrator.rollbackPending,
      forgetWindowHandles: orchestrator.forgetHandles,
      releaseDocuments: () => {
        const ids = store.getLive().documents.map((document) => document.id);
        releaseFileDocuments(ids);
        fileDomain.invalidateLoads(ids);
      },
      clearPtyRuntime: () => ptyDomain.terminalRefs.current.clear(),
      rebuildCoordinator: () => contentCoordinatorRef.current.reset(),
    });
    saveQueueRef.current = null;
    patchHost(
      {
        ptySessionsById: {},
        slots: [],
        documents: [],
        buffers: {},
        tree: createWorkspacePane(initialPaneId),
        focusedPaneId: initialPaneId,
        treeRevision: store.getLive().treeRevision + 1,
      },
      "rehydrateWorkspace:reset",
    );
    await hydrateWorkspace();
  }, [hydrateWorkspace, initialPaneId, releaseFileDocuments]);

  const commands = useMemo<WorkspaceCommands>(
    () => ({
      launchSession,
      openProjectFile,
      loadFile,
      activateFile,
      activateUnsupportedContent,
      editFile,
      saveFile,
      closeContents,
      detachFile: orchestrator.detachFile,
      focusPane,
      activateSession,
      splitPane,
      splitAndMoveSession,
      splitAndMoveFile,
      moveSession,
      moveFile,
      isManagedDetachedDrag: orchestrator.isManagedDetachedDrag,
      isManagedDetachedFileDrag: orchestrator.isManagedDetachedFileDrag,
      detachSession: orchestrator.detachSession,
      closeEmptyPane,
      updateSplitRatio,
      retryHydration,
      resetWorkspace,
      applyWorkspaceLayoutPreset,
      getCurrentPresetLayout,
      removeSlot,
      recordSession,
      collectExitImpacts,
      getBackupRestoreBlockers,
      cancelBackupRestore,
      resumeAfterFailedRestore,
      rehydrateWorkspace,
      getDirectoryRemovalBlockers,
    }),
    [
      launchSession,
      openProjectFile,
      loadFile,
      activateFile,
      activateUnsupportedContent,
      editFile,
      saveFile,
      closeContents,
      focusPane,
      activateSession,
      splitPane,
      splitAndMoveSession,
      splitAndMoveFile,
      moveSession,
      moveFile,
      closeEmptyPane,
      updateSplitRatio,
      retryHydration,
      resetWorkspace,
      applyWorkspaceLayoutPreset,
      getCurrentPresetLayout,
      removeSlot,
      recordSession,
      collectExitImpacts,
      getBackupRestoreBlockers,
      cancelBackupRestore,
      resumeAfterFailedRestore,
      rehydrateWorkspace,
      getDirectoryRemovalBlockers,
    ],
  );
  const value = useMemo<PtyWorkspaceContextValue>(
    () => ({
      ...commands,
      slots,
      fileDocuments,
      fileBuffers,
      handoffFileIds,
      detachedFileIds,
      tree,
      workspaceTreeRevision,
      focusedPaneId,
      hydrationStatus,
      hydrationError,
      layoutSaveError,
      layoutResetError,
      layoutResetPending,
      portalTargets,
      terminalRefs,
      detachedInstanceIds,
      closingContentKeys,
      hasDetachedSessions: detachedInstanceIds.size > 0,
    }),
    [
      commands,
      slots,
      fileDocuments,
      fileBuffers,
      handoffFileIds,
      detachedFileIds,
      tree,
      workspaceTreeRevision,
      focusedPaneId,
      hydrationStatus,
      hydrationError,
      layoutSaveError,
      layoutResetError,
      layoutResetPending,
      portalTargets,
      terminalRefs,
      detachedInstanceIds,
      closingContentKeys,
    ],
  );

  return (
    <WorkspaceHostStoreContext.Provider value={store}>
      <WorkspaceCommandsContext.Provider value={commands}>
        <PtyWorkspaceContext.Provider value={value}>
          {children}
          {closeConfirmationImpacts && (
            <ImpactConfirmDialog
              impacts={closeConfirmationImpacts}
              onCancel={() => resolveCloseConfirmation(false)}
              onConfirm={() => resolveCloseConfirmation(true)}
            />
          )}
          {(hydrationStatus === "ready" ||
            hydrationStatus === "needsReset") && (
            <WorkspacePtySessionRegistry
              slots={slots}
              tree={tree}
              focusedPaneId={focusedPaneId}
              active={activeView === "detail"}
              terminalRefs={terminalRefs}
              onSessionChange={recordSession}
              onPortalTarget={registerPortalTarget}
              onFocusPane={focusPane}
              detachedInstanceIds={detachedInstanceIds}
            />
          )}
        </PtyWorkspaceContext.Provider>
      </WorkspaceCommandsContext.Provider>
    </WorkspaceHostStoreContext.Provider>
  );
}

function toWorkspaceLayoutSlot(
  slot: PtyWorkspaceSlot,
  directories: Directory[],
): WorkspaceLayoutSlot {
  const directory = directories.find((entry) => entry.id === slot.directoryId);
  return {
    instanceId: slot.instanceId,
    directoryId: slot.directoryId,
    directoryPath: directory?.path ?? slot.directoryPath,
    projectName: directory?.name ?? slot.projectName,
    toolKey: slot.toolKey,
    sequence: slot.sequence,
    sessionId: slot.sessionId ?? null,
    resumeSessionId: slot.resumeSessionId ?? null,
    title: { ...slot.title },
  };
}

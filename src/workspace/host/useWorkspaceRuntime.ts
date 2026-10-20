import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  presentWorkspaceContent,
  tryGetWorkspaceContentAdapter,
  workspaceContentProjectContext,
  type WorkspaceContentPresentationContext,
} from "../../components/WorkspaceContentView";
import { useDirectories } from "../../hooks/queries";
import {
  findWorkspacePane,
  listWorkspacePanes,
  type WorkspaceNode,
} from "../../lib/ptyWorkspaceLayout";
import { reduceWorkspaceTree } from "../../lib/workspaceContentCommand";
import { disposeWorkspaceContent } from "../../lib/workspaceContentClose";
import { WorkspaceContentCoordinator } from "../../lib/workspaceContentCoordinator";
import {
  fileContentRef,
  ptyContentKey,
  ptyContentRef,
} from "../../lib/workspaceContentKey";
import { LISTENER_REGISTRATION_RETRY_DELAYS_MS } from "../../lib/workspaceContentListenerSetup";
import { droppedFileDocumentIds } from "../../lib/workspaceFileDocumentRelease";
import {
  isHandoffActive,
  isWindowOwned,
} from "../../lib/workspaceOwnershipProjection";
import type { IsolatedRegistrationFailure } from "../../lib/retryPolicy";
import type { WorkspacePaneContentRef } from "../../lib/tauri";
import { useAppStore } from "../../store/appStore";
import { ProjectPathSemanticsRegistry } from "../../lib/projectPathSemantics";
import { formatAppError } from "../../lib/appErrors";
import { checkProjectFilesSameIdentity } from "../../lib/tauri";
import { createFileContentDomain } from "../domains/fileContentDomain";
import { createFileDocumentsDomain } from "../domains/fileDocumentsDomain";
import { createPtyContentDomain } from "../domains/ptyContentDomain";
import { createPtySlotsDomain } from "../domains/ptySlotsDomain";
import { createWorkspaceDomainTable } from "../domains/workspaceDomainTable";
import {
  createWorkspacePersistence,
  latestPersistenceDeps,
  type RuntimeResetNext,
  type WorkspacePersistenceDeps,
} from "../persistence/workspacePersistence";
import { useWorkspacePersistence } from "../persistence/useWorkspacePersistence";
import {
  createContentWindowOrchestrator,
  latestContentWindowDeps,
  type ContentWindowDeps,
} from "../windows/contentWindowOrchestrator";
import { createFileProtocolHandlers } from "../windows/protocolHandlers.file";
import { createPtyProtocolHandlers } from "../windows/protocolHandlers.pty";
import {
  createContentWindowProtocol,
  useContentWindowProtocol,
} from "../windows/useContentWindowProtocol";
import { useCloseConfirmation } from "./useCloseConfirmation";
import { useCoordinatorProjection } from "./useCoordinatorProjection";
import type { HostResetReason, HostRuntimeSteps } from "./resetHostRuntime";
import { createWorkspaceCommandExecutor } from "./workspaceCommandExecutor";
import {
  WorkspaceHostStore,
  createInitialHostSnapshot,
  type HostSnapshot,
} from "./workspaceHostStore";
import {
  createWorkspaceLifecycleGuards,
  latestGuardDeps,
  type WorkspaceLifecycleGuardsDeps,
} from "./workspaceLifecycleGuards";

export interface WorkspaceRuntimeOptions {
  /** 仅测试注入：宿主 harness 用它观察与断言内容归属状态。生产代码不传。 */
  coordinator?: WorkspaceContentCoordinator;
  /** 仅测试注入：监听注册的重试间隔（默认 [100, 300]）。 */
  listenerRetryDelaysMs?: readonly number[];
}

export type WorkspaceRuntime = ReturnType<typeof useWorkspaceRuntime>;

/** 实例构造与接线：store、协调器、领域、注入表、执行器、窗口编排、协议与持久化。 */
export function useWorkspaceRuntime({
  coordinator,
  listenerRetryDelaysMs,
}: WorkspaceRuntimeOptions) {
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
  const closeConfirmation = useCloseConfirmation();
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
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const [portalTargets, setPortalTargets] = useState<
    Record<string, HTMLDivElement>
  >({});
  const [ptyDomain] = useState(() => createPtySlotsDomain());
  const terminalRefs = ptyDomain.terminalRefs;
  const contentCoordinatorRef = useRef(
    coordinator ?? new WorkspaceContentCoordinator(),
  );
  // 窗口编排：句柄表、pending 表与返回等待中止器由 orchestrator 持有；依赖经 depsRef 读取最新值（R-FE-1）。
  const depsRef = useRef<ContentWindowDeps | null>(null);
  const [orchestrator] = useState(() =>
    createContentWindowOrchestrator(latestContentWindowDeps(depsRef)),
  );
  // 项目的路径语义（PD-10）：每个宿主一份，hydrate 开始与备份恢复时清空。
  const [pathSemantics] = useState(() => new ProjectPathSemanticsRegistry());
  const releaseFileDocumentsRef = useRef<
    ((documentIds: readonly string[]) => void) | null
  >(null);
  // 文件领域：文件文档与缓冲的加载、编辑、保存、关闭经由领域对象完成（惰性初始化，闭包按调用时读取 ref）。
  const [fileDomain] = useState(() =>
    createFileDocumentsDomain(store, {
      getPathSemantics: (directoryId) => pathSemantics.get(directoryId),
      loadPathSemantics: (directoryId, directoryPath) =>
        pathSemantics.load(directoryId, directoryPath),
      compareFileIdentity: checkProjectFilesSameIdentity,
      releaseDocuments: (ids) => releaseFileDocumentsRef.current?.(ids),
      isRestoreInProgress: () => persistence.restoreLatch.active,
      getHydrationEpoch: () => persistence.hydrationEpoch(),
      isHandoffActive: (documentId) =>
        isHandoffActive(
          contentCoordinatorRef.current.get(fileContentRef(documentId)),
        ),
      getTranslate: () => tRef.current,
      notify: {
        error: (message, options) => toast.error(message, options),
        warning: (message) => toast.warning(message),
      },
    }),
  );
  useEffect(() => () => orchestrator.abortReturnWait(), [orchestrator]);
  const projection = useCoordinatorProjection(contentCoordinatorRef.current);
  const activeView = useAppStore((state) => state.view);

  const releaseFileDocuments = useCallback((documentIds: readonly string[]) => {
    if (documentIds.length === 0) return;
    const dispose = tryGetWorkspaceContentAdapter("file")?.lifecycle?.dispose;
    if (!dispose) return;
    for (const documentId of documentIds) {
      void (async () => {
        try {
          await dispose({
            content: fileContentRef(documentId),
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
  releaseFileDocumentsRef.current = releaseFileDocuments;

  // 布局持久化：hydrate 与保存只经显式入口（挂载、重试、恢复、拖拽结束、卸载）触发；依赖经 persistenceDepsRef 读取最新值（R-FE-1）。
  const directoriesRef = useRef(directories);
  directoriesRef.current = directories;
  const persistenceDepsRef = useRef<WorkspacePersistenceDeps | null>(null);
  const [persistence] = useState(() =>
    createWorkspacePersistence(
      latestPersistenceDeps(persistenceDepsRef, store),
    ),
  );
  const persistenceStatus = useSyncExternalStore(
    persistence.subscribeStatus,
    persistence.getStatus,
    persistence.getStatus,
  );
  // hydrate 与 rehydrate 共用的运行期重置步骤（与 m6-048 的两处 resetHostRuntime 第二实参逐项等价）。
  const buildRuntimeSteps = (
    reason: HostResetReason,
    next: RuntimeResetNext | null,
  ): HostRuntimeSteps => ({
    rollbackPending: orchestrator.rollbackPending,
    forgetWindowHandles: orchestrator.forgetHandles,
    releaseDocuments: () => {
      if (reason === "hydrate" && next) {
        // 释放旧文档必须读取提交前的文档集合，因此在发布新状态之前执行。
        releaseFileDocuments(
          droppedFileDocumentIds(store.getLive().documents, next.documents),
        );
        fileDomain.invalidateLoads(
          new Set([
            ...store.getLive().documents.map((document) => document.id),
            ...next.documents.map((document) => document.id),
          ]),
        );
        return;
      }
      const ids = store.getLive().documents.map((document) => document.id);
      releaseFileDocuments(ids);
      fileDomain.invalidateLoads(ids);
    },
    clearPtyRuntime:
      reason === "rehydrate"
        ? () => ptyDomain.terminalRefs.current.clear()
        : () => undefined,
    rebuildCoordinator:
      reason === "hydrate" && next
        ? () =>
            contentCoordinatorRef.current.resetFromPanes(
              listWorkspacePanes(next.tree),
              "main",
            )
        : () => contentCoordinatorRef.current.reset(),
  });
  persistenceDepsRef.current = {
    store,
    getCoordinator: () => contentCoordinatorRef.current,
    getDirectories: () => directoriesRef.current,
    translate: tRef.current,
    initialPaneId,
    runtimeSteps: buildRuntimeSteps,
    invalidateDocuments: (ids) => fileDomain.invalidateLoads(ids),
    releaseDocuments: (ids) => releaseFileDocuments(ids),
    getPathSemantics: (directoryId) => pathSemantics.get(directoryId),
    onHydrateStart: () => pathSemantics.clear(),
    afterHydrated: (epoch) => {
      // hydrate 只做精确去重；flag 到达之后才折叠合并大小写重复文档（显式入口，不进 effect）。
      const directories = new Map<number, string>();
      for (const document of store.getLive().documents) {
        if (!directories.has(document.directoryId)) {
          directories.set(document.directoryId, document.directoryPath);
        }
      }
      if (directories.size === 0) return;
      void (async () => {
        const counts = await Promise.all(
          [...directories].map(async ([directoryId, directoryPath]) => {
            await pathSemantics.load(directoryId, directoryPath);
            return fileDomain
              .mergeCaseVariants(directoryId, directoryPath, epoch)
              .catch(() => 0);
          }),
        );
        const merged = counts.reduce((sum, count) => sum + count, 0);
        if (merged > 0) {
          toast.info(
            tRef.current("workspaceFiles.caseVariantsMerged", {
              count: merged,
            }),
          );
        }
      })();
    },
    repairCaseDuplicates: async (documentIds, mode, error) => {
      if (mode === "degrade") {
        const dropped = fileDomain.degradeCaseVariants(documentIds);
        if (dropped > 0) {
          toast.warning(formatAppError(error, tRef.current));
        }
        return dropped > 0;
      }
      const epoch = persistence.hydrationEpoch();
      const directories = new Map<number, string>();
      for (const document of store.getLive().documents) {
        if (
          documentIds.includes(document.id) &&
          !directories.has(document.directoryId)
        ) {
          directories.set(document.directoryId, document.directoryPath);
        }
      }
      let merged = 0;
      for (const [directoryId, directoryPath] of directories) {
        await pathSemantics.load(directoryId, directoryPath);
        merged += await fileDomain
          .mergeCaseVariants(directoryId, directoryPath, epoch)
          .catch(() => 0);
      }
      return merged > 0;
    },
  };
  useWorkspacePersistence(persistence, orchestrator);

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
      isRestoreInProgress: () => persistence.restoreLatch.active,
      afterCommit: (ref) => syncProjectContextRef.current(ref),
      newId: () => crypto.randomUUID(),
    }),
  );

  const loadFile = fileDomain.load;

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

  const removeSlot = useCallback(
    (instanceId: string, options: { disposeOwnerEnded?: boolean } = {}) => {
      const content = ptyContentRef(instanceId);
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
        ptyContentRef(instanceId),
        getWorkspacePresentationContext(),
      ).title,
    openDirectory: (directoryId) =>
      useAppStore.getState().openDirectory(directoryId),
  };

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

  const guardDepsRef = useRef<WorkspaceLifecycleGuardsDeps | null>(null);
  const [guards] = useState(() =>
    createWorkspaceLifecycleGuards(latestGuardDeps(guardDepsRef, store)),
  );
  guardDepsRef.current = {
    store,
    getCoordinator: () => contentCoordinatorRef.current,
    orchestrator,
    persistence,
    mergeFileBuffers: (entries, reason) =>
      fileDomain.mergeBuffers(entries, reason),
    waitForAllFileSaves: () => fileDomain.waitForAllSaves(),
    runningPtySessions: (live) => ptyDomain.runningSessions(live),
    runningPtyCountIn: (live, directoryId) =>
      ptyDomain.runningCountIn(live, directoryId),
  };

  return {
    store,
    snapshot,
    tRef,
    directories,
    contentCoordinatorRef,
    closeConfirmation,
    projection,
    persistence,
    persistenceStatus,
    orchestrator,
    fileDomain,
    ptyDomain,
    terminalRefs,
    portalTargets,
    registerPortalTarget,
    activeView,
    commitTree,
    setFocusedPane,
    removeSlot,
    loadFile,
    domainTable,
    executor,
    guards,
  };
}

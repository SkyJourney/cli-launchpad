import clsx from "clsx";
import { Allotment, type AllotmentHandle } from "allotment";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { listen } from "@tauri-apps/api/event";
import {
  ChevronDown,
  Check,
  Columns2,
  LayoutTemplate,
  Layers,
  Pencil,
  Rows2,
  Save,
  Trash2,
  X,
} from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MutableRefObject,
  type ReactNode,
  type DragEvent as ReactDragEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useDirectories } from "../hooks/queries";
import { abortableDelay } from "../lib/abortableDelay";
import { createWindowLabel, windowKindOf } from "../lib/windowKinds";
import {
  emitWorkspaceContentWindowEvent,
  listenWorkspaceContentWindowEvent,
} from "../lib/workspaceContentWindowProtocol";
import {
  type WorkspaceNode,
  addWorkspaceFileToPane,
  addSessionToWorkspacePane,
  canSplitWorkspacePane,
  createWorkspacePane,
  findWorkspacePane,
  listWorkspacePanes,
  listWorkspacePaneContents,
  hasWorkspaceContent,
  splitWorkspaceContentSequence,
  workspacePaneOtherContents,
  MIN_WORKSPACE_PANE_HEIGHT,
  MIN_WORKSPACE_PANE_WIDTH,
  minimumWorkspacePaneExtent,
  isUsableWorkspaceSplitSizes,
  nextWorkspaceSessionSequence,
  removeEmptyWorkspacePane,
  remapWorkspaceFileIds,
  setWorkspaceSplitRatio,
  splitWorkspacePane,
  type SplitDirection,
  type WorkspacePane,
  workspaceSplitSizes,
  WORKSPACE_SASH_SIZE,
} from "../lib/ptyWorkspaceLayout";
import {
  encodePtySessionDrag,
  parsePtySessionDrag,
  PTY_SESSION_DRAG_TYPE,
} from "../lib/ptySessionDrag";
import {
  encodeWorkspaceContentDrag,
  parseWorkspaceContentDrag,
  WORKSPACE_CONTENT_DRAG_TYPE,
} from "../lib/workspaceContentDrag";
import {
  matchesDetachedWindow,
  nextOwnerQueryStep,
  PTY_OWNER_QUERY_MAX_RETRIES,
  PTY_OWNER_QUERY_RETRY_DELAY_MS,
  resolveDetachedStartTimeoutAction,
} from "../lib/ptySessionLifecycle";
import { matchesWorkspaceFileWindow } from "../lib/workspaceFileWindow";
import {
  LISTENER_REGISTRATION_RETRY_DELAYS_MS,
  setupWorkspaceContentListeners,
} from "../lib/workspaceContentListenerSetup";
import {
  retryWithBackoff,
  type IsolatedRegistrationFailure,
} from "../lib/retryPolicy";
import {
  PTY_OWNER_LOST_MAX_ATTEMPTS,
  ptyOwnerLostRetryDelay,
  type PtyOwnerLostAttemptResult,
} from "../lib/ptyOwnerLostRecovery";
import {
  clearPendingWorkspaceContentWindows,
  promotePendingWorkspaceContentWindow,
  registerPendingWorkspaceContentWindow,
  retainAsyncUnlisten,
  takePendingWorkspaceContentWindow,
  type WorkspaceContentWindowRecord,
} from "../lib/workspaceContentWindowRegistry";
import {
  advancePendingWindowStage,
  initialPendingStage,
  type PendingWindowStage,
} from "../lib/workspaceContentPendingStage";
import {
  getPtySessionWindowStatus,
  getWorkspaceLayout,
  createWorkspaceLayoutPreset,
  deleteWorkspaceLayoutPreset,
  listWorkspaceLayoutPresets,
  planApplyWorkspaceLayoutPreset,
  renameWorkspaceLayoutPreset,
  updateWorkspaceLayoutPreset,
  resetWorkspaceLayout,
  saveWorkspaceLayout,
  grantContentWindowFile,
  revokeContentWindowFile,
  openProjectFile as openProjectFileContent,
  saveProjectTextFile,
  type Directory,
  type WorkspaceFileDocument,
  type PtySession,
  type ToolKey,
  type WorkspaceLayoutDocument,
  type WorkspaceLayoutSlot,
  type WorkspaceLayoutPresetSummary,
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
  ownerWindowOf,
} from "../lib/workspaceOwnershipProjection";
import {
  createWorkspaceFileBuffer,
  completeWorkspaceFileSave,
  editWorkspaceFileBuffer,
  beginWorkspaceFileSave,
  failWorkspaceFileSave,
  markWorkspaceFileIdentityChanged,
  isWorkspaceFileBufferNewer,
  resolveWorkspaceFileSaveCommitDisposition,
  workspaceFileDocumentIdentityMatches,
  markWorkspaceFileSaveConflict,
  WorkspaceFileOperationFlights,
} from "../lib/workspaceFileBuffer";
import { closeWorkspaceFileState } from "../lib/workspaceFileClose";
import {
  formatAppError,
  isProjectIdentityChangedError,
} from "../lib/appErrors";
import {
  collectAppExitImpacts,
  type AppExitImpacts,
} from "../lib/appExitImpacts";
import { WorkspaceContentCoordinator } from "../lib/workspaceContentCoordinator";
import { workspaceContentKey } from "../lib/workspaceContentKey";
import { requestWorkspaceFileBufferFlush } from "../lib/workspaceFileExitFlush";
import type { WorkspaceDataRestoreBlockers } from "../lib/workspaceRestorePolicy";
import { hasWorkspaceDataRestoreBlockers } from "../lib/workspaceRestorePolicy";
import {
  canChangeWorkspaceContentPane,
  type WorkspaceContentHandoffPayloadByKind,
} from "../lib/workspaceContentLifecycle";
import { useAppStore } from "../store/appStore";
import { AnchoredPopover } from "./AnchoredPopover";
import {
  WorkspaceContentView,
  presentWorkspaceContent,
  tryGetWorkspaceContentAdapter,
  workspaceContentProjectContext,
  type WorkspaceContentPresentationContext,
} from "./WorkspaceContentView";
import { WorkspaceContentTab } from "./WorkspaceContentTab";
import { WorkspaceContentContextMenu } from "./WorkspaceContentContextMenu";
import {
  planWorkspaceReturn,
  reduceWorkspaceTree,
  resolveWorkspaceReturnPaneId,
} from "../lib/workspaceContentCommand";
import { partitionVisibleTabs } from "../lib/workspaceTabLayout";
import type { WorkspaceFileBuffer } from "../lib/workspaceFileBuffer";
import {
  closeWorkspaceContentBatch,
  disposeWorkspaceContent,
  shouldCloseWorkspaceContent,
  type WorkspaceContentDisposalImpact,
  type WorkspaceContentDisposeContext,
} from "../lib/workspaceContentClose";
import {
  attachWorkspaceContentHandoff,
  createWorkspaceContentWindow,
  prepareWorkspaceContentHandoff,
  rollbackWorkspaceContentHandoff,
  WORKSPACE_CONTENT_WINDOW_HANDOFF_TIMEOUT_MS,
} from "./workspaceContentHandoffRuntime";
import type { WorkspaceContentHandoffHookContext } from "./workspaceContentAdapterRegistry";
import type { PtyTerminalHandle } from "./PtyTerminal";
import {
  WorkspacePtySessionRegistry,
  type PtyWorkspaceSlot,
} from "./WorkspacePtySessionRegistry";
import "allotment/dist/style.css";

type PtyWorkspaceHydrationStatus =
  | "loading"
  | "ready"
  | "needsReset"
  | "loadFailed";

type SplitResizePhase = "change" | "dragEnd";

interface DetachedWindowRecord {
  instanceId: string;
  sessionId: string;
  windowLabel: string;
}

interface PendingContentWindow<
  K extends "pty" | "file",
> extends WorkspaceContentWindowRecord {
  kind: K;
  stage: PendingWindowStage;
  token: string;
  window: WebviewWindow;
  resolve: () => void;
  reject: (reason: Error) => void;
  handoffContext?: WorkspaceContentHandoffHookContext<K>;
  handoffPayload?: WorkspaceContentHandoffPayloadByKind[K];
}

type PendingDetachedWindow = PendingContentWindow<"pty"> &
  DetachedWindowRecord & {
    handoffContext: WorkspaceContentHandoffHookContext<"pty">;
    handoffPayload: WorkspaceContentHandoffPayloadByKind["pty"];
    /** 对账时 owner 查询已连续失败的次数；随 tracked 展开复制。 */
    ownerQueryRetries?: number;
  };

interface DetachedWindowReadyEvent extends DetachedWindowRecord {}

interface PtySessionOwnerLostEvent {
  sessionId: string;
}

interface WorkspaceContentWindowLostEvent {
  windowLabel: string;
}

interface PtyReturnRequestEvent extends DetachedWindowRecord {
  token: string;
  targetPaneId?: string;
}

interface PendingWorkspaceFileWindow extends PendingContentWindow<"file"> {
  documentId: string;
  sourcePaneId?: string;
}

type ResolvedPaneContent =
  | {
      content: Extract<WorkspacePaneContentRef, { kind: "pty" }>;
      slot: PtyWorkspaceSlot;
    }
  | {
      content: Extract<WorkspacePaneContentRef, { kind: "file" }>;
      file: WorkspaceFileDocument;
    }
  | {
      content: Extract<WorkspacePaneContentRef, { kind: "unknown" }>;
    };

interface PtyWorkspaceContextValue {
  slots: PtyWorkspaceSlot[];
  fileDocuments: WorkspaceFileDocument[];
  fileBuffers: Record<string, WorkspaceFileBuffer>;
  handoffFileIds: Set<string>;
  detachedFileIds: Set<string>;
  tree: WorkspaceNode;
  workspaceTreeRevision: number;
  focusedPaneId: string;
  hydrationStatus: PtyWorkspaceHydrationStatus;
  hydrationError: string | null;
  layoutSaveError: string | null;
  layoutResetError: string | null;
  layoutResetPending: boolean;
  portalTargets: Record<string, HTMLDivElement>;
  terminalRefs: MutableRefObject<Map<string, PtyTerminalHandle>>;
  launchSession: (
    directoryId: number,
    toolKey: ToolKey,
    resumeSessionId?: string,
  ) => void;
  openProjectFile: (
    directoryId: number,
    directoryPath: string,
    relativePath: string,
  ) => Promise<void>;
  loadFile: (documentId: string) => Promise<void>;
  activateFile: (paneId: string, documentId: string) => void;
  activateUnsupportedContent: (
    paneId: string,
    content: Extract<WorkspacePaneContentRef, { kind: "unknown" }>,
  ) => void;
  editFile: (documentId: string, content: string) => void;
  saveFile: (documentId: string) => Promise<void>;
  closeContents: (
    contents: WorkspacePaneContentRef[],
    origin: "tab" | "menu" | "stack" | "window",
    onApproved?: () => void,
  ) => Promise<void>;
  detachFile: (documentId: string) => Promise<void>;
  focusPane: (paneId: string) => void;
  activateSession: (paneId: string, instanceId: string) => void;
  splitPane: (paneId: string, direction: SplitDirection) => void;
  splitAndMoveSession: (
    paneId: string,
    instanceId: string,
    direction: SplitDirection,
  ) => void;
  splitAndMoveFile: (
    paneId: string,
    documentId: string,
    direction: SplitDirection,
  ) => void;
  moveSession: (
    sourcePaneId: string,
    destinationPaneId: string,
    instanceId: string,
  ) => void;
  moveFile: (
    sourcePaneId: string,
    destinationPaneId: string,
    documentId: string,
  ) => void;
  detachedInstanceIds: Set<string>;
  closingContentKeys: Set<string>;
  hasDetachedSessions: boolean;
  isManagedDetachedDrag: (instanceId: string, windowLabel: string) => boolean;
  isManagedDetachedFileDrag: (
    documentId: string,
    windowLabel: string,
  ) => boolean;
  detachSession: (instanceId: string) => Promise<void>;
  closeEmptyPane: (paneId: string) => void;
  updateSplitRatio: (
    splitId: string,
    sizes: number[],
    phase: SplitResizePhase,
  ) => void;
  retryHydration: () => void;
  resetWorkspace: () => Promise<void>;
  applyWorkspaceLayoutPreset: (presetId: string) => Promise<void>;
  getCurrentPresetLayout: () => WorkspaceLayoutDocument;
  removeSlot: (
    instanceId: string,
    options?: { disposeOwnerEnded?: boolean },
  ) => void;
  recordSession: (instanceId: string, session: PtySession | null) => void;
  collectExitImpacts: (ptyCount: number) => Promise<AppExitImpacts>;
  getBackupRestoreBlockers: () => Promise<WorkspaceDataRestoreBlockers>;
  cancelBackupRestore: () => void;
  rehydrateWorkspace: () => Promise<void>;
  getDirectoryRemovalBlockers: (directoryId: number) => {
    openFileCount: number;
    runningPtyCount: number;
  };
}

const PtyWorkspaceContext = createContext<PtyWorkspaceContextValue | null>(
  null,
);

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
  const lifecycleAbortRef = useRef(new AbortController());
  const ownerLostRecoveriesRef = useRef(new Set<string>());
  useEffect(() => {
    // 严格模式下首个 effect 清理会中止第一个控制器，第二次运行时重建。
    if (lifecycleAbortRef.current.signal.aborted) {
      lifecycleAbortRef.current = new AbortController();
    }
    const controller = lifecycleAbortRef.current;
    return () => controller.abort();
  }, []);
  const { data: directories } = useDirectories();
  const [hydrationStatus, setHydrationStatus] =
    useState<PtyWorkspaceHydrationStatus>("loading");
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
  const [slots, setSlots] = useState<PtyWorkspaceSlot[]>([]);
  const [fileDocuments, setFileDocuments] = useState<WorkspaceFileDocument[]>(
    [],
  );
  const [fileBuffers, setFileBuffers] = useState<
    Record<string, WorkspaceFileBuffer>
  >({});
  const [tree, setTree] = useState<WorkspaceNode>(() =>
    createWorkspacePane(initialPaneId),
  );
  const [workspaceTreeRevision, setWorkspaceTreeRevision] = useState(0);
  const [focusedPaneId, setFocusedPaneId] = useState(initialPaneId);
  const [portalTargets, setPortalTargets] = useState<
    Record<string, HTMLDivElement>
  >({});
  const terminalRefs = useRef(new Map<string, PtyTerminalHandle>());
  const saveQueueRef = useRef<WorkspaceLayoutSaveQueue | null>(null);
  const backupRestoreInProgressRef = useRef(false);
  const hydrationRequestRef = useRef(0);
  const hydrationStatusRef = useRef(hydrationStatus);
  const ratioSaveTimerRef = useRef<number | null>(null);
  const splitResizeInProgressRef = useRef(false);
  const persistLatestRef = useRef<(() => void) | null>(null);
  const slotsRef = useRef(slots);
  const fileDocumentsRef = useRef(fileDocuments);
  const fileBuffersRef = useRef(fileBuffers);
  const fileOperationGenerationsRef = useRef(new Map<string, number>());
  const openingFileRequestsRef = useRef(new Map<string, Promise<void>>());
  const fileOperationFlightsRef = useRef(new WorkspaceFileOperationFlights());
  const treeRef = useRef(tree);
  const focusedPaneIdRef = useRef(focusedPaneId);
  const detachedByInstanceRef = useRef(new Map<string, WebviewWindow>());
  const pendingDetachedRef = useRef(new Map<string, PendingDetachedWindow>());
  const detachedFilesRef = useRef(new Map<string, WebviewWindow>());
  const contentCoordinatorRef = useRef(
    coordinator ?? new WorkspaceContentCoordinator(),
  );
  const ptyReturnWaitAbortRef = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      ptyReturnWaitAbortRef.current?.abort();
      ptyReturnWaitAbortRef.current = null;
    },
    [],
  );
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
          .map(workspaceContentReactKey),
      ),
    [contentCoordinatorRevision],
  );
  const pendingDetachedFilesRef = useRef(
    new Map<string, PendingWorkspaceFileWindow>(),
  );
  const upsertPtySession = useAppStore((state) => state.upsertPtySession);
  const removePtySession = useAppStore((state) => state.removePtySession);
  const activeView = useAppStore((state) => state.view);

  slotsRef.current = slots;
  fileDocumentsRef.current = fileDocuments;
  fileBuffersRef.current = fileBuffers;
  if (!splitResizeInProgressRef.current) treeRef.current = tree;
  focusedPaneIdRef.current = focusedPaneId;
  hydrationStatusRef.current = hydrationStatus;

  const getFileOperationGeneration = (documentId: string) =>
    fileOperationGenerationsRef.current.get(documentId) ?? 0;
  const invalidateFileOperationGeneration = (documentId: string) => {
    fileOperationGenerationsRef.current.set(
      documentId,
      getFileOperationGeneration(documentId) + 1,
    );
  };

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
      if (hydrationStatusRef.current !== "ready") return;
      if (backupRestoreInProgressRef.current) return;
      const queue = saveQueueRef.current;
      if (!queue) return;

      const snapshotTree = treeOverride ?? treeRef.current;
      // 快照构造不得把异常抛进 effect：根边界只能兜底成重载提示（丢失未保存缓冲），
      // 所以这里降级为一次可自愈的保存错误，下一次状态变化会重新保存。
      try {
        const persistedSlots: WorkspaceLayoutSlot[] = slotsRef.current.map(
          (slot) => toWorkspaceLayoutSlot(slot, directories ?? []),
        );
        queue.enqueue(
          createWorkspaceLayoutDocument({
            tree: snapshotTree,
            focusedPaneId: focusedPaneIdRef.current,
            slots: persistedSlots,
            documents: fileDocumentsRef.current,
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

  const hydrateWorkspace = useCallback(async () => {
    const requestId = ++hydrationRequestRef.current;
    setHydrationStatus("loading");
    setHydrationError(null);
    setLayoutResetError(null);
    saveQueueRef.current = null;

    try {
      const read = await getWorkspaceLayout();
      if (requestId !== hydrationRequestRef.current) return;
      const revision = read.revision ?? 0;

      if (read.status.status === "needsReset") {
        setHydrationError(read.status.reason);
        setHydrationStatus("needsReset");
        return;
      }

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
        contentCoordinatorRef.current.resetFromPanes(
          listWorkspacePanes(restoredSnapshot.tree),
          "main",
        );
        const restoredSlots: PtyWorkspaceSlot[] = restoredSnapshot.slots;

        new Set([
          ...fileDocumentsRef.current.map((document) => document.id),
          ...(restoredSnapshot.documents ?? []).map((document) => document.id),
        ]).forEach(invalidateFileOperationGeneration);

        slotsRef.current = restoredSlots;
        treeRef.current = restoredSnapshot.tree;
        focusedPaneIdRef.current = restoredSnapshot.focusedPaneId;
        setSlots(restoredSlots);
        setFileDocuments(restoredSnapshot.documents ?? []);
        setFileBuffers({});
        detachedByInstanceRef.current.clear();
        detachedFilesRef.current.clear();
        clearPendingWorkspaceContentWindows(
          pendingDetachedRef.current,
          (pending) => {
            contentCoordinatorRef.current.failHandoff(
              { kind: "pty", slotId: pending.instanceId },
              "detachCancelled",
              pending.token,
            );
            pending.reject(new Error(tRef.current("pty.detachedStateChanged")));
            void pending.window.destroy().catch(() => undefined);
          },
        );
        clearPendingWorkspaceContentWindows(
          pendingDetachedFilesRef.current,
          (pending) => {
            contentCoordinatorRef.current.failHandoff(
              { kind: "file", documentId: pending.documentId },
              "detachCancelled",
              pending.token,
            );
            pending.reject(new Error(tRef.current("pty.detachedStateChanged")));
            void pending.window.destroy().catch(() => undefined);
          },
        );
        setTree(restoredSnapshot.tree);
        setFocusedPaneId(restoredSnapshot.focusedPaneId);
      }

      saveQueueRef.current = createSaveQueue(revision);
      setLayoutSaveError(null);
      setHydrationStatus("ready");
    } catch (reason) {
      if (requestId !== hydrationRequestRef.current) return;
      if (reason instanceof UnsupportedWorkspaceLayoutVersionError) {
        setHydrationError(reason.message);
        setHydrationStatus("needsReset");
        return;
      }
      setHydrationError(formatAppError(reason, tRef.current));
      setHydrationStatus("loadFailed");
    }
  }, [createSaveQueue]);

  useEffect(() => {
    void hydrateWorkspace();
    return () => {
      hydrationRequestRef.current += 1;
      const cleanupError = new Error("工作区内容宿主已卸载");
      clearPendingWorkspaceContentWindows(
        pendingDetachedRef.current,
        (pending) => {
          void rollbackWorkspaceContentHandoff(
            pending.handoffContext,
            pending.handoffPayload,
            cleanupError,
          ).catch(() => undefined);
          contentCoordinatorRef.current.failHandoff(
            { kind: "pty", slotId: pending.instanceId },
            "detachCancelled",
            pending.token,
          );
          pending.reject(cleanupError);
          void pending.window.destroy().catch(() => undefined);
        },
      );
      clearPendingWorkspaceContentWindows(
        pendingDetachedFilesRef.current,
        (pending) => {
          if (pending.handoffContext) {
            void rollbackWorkspaceContentHandoff(
              pending.handoffContext,
              pending.handoffPayload,
              cleanupError,
            ).catch(() => undefined);
          }
          contentCoordinatorRef.current.failHandoff(
            { kind: "file", documentId: pending.documentId },
            "detachCancelled",
            pending.token,
          );
          pending.reject(cleanupError);
          void pending.window.destroy().catch(() => undefined);
        },
      );
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
      if (hydrationStatusRef.current === "ready") {
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
    if (hydrationStatusRef.current !== "needsReset") return;
    setLayoutResetPending(true);
    setLayoutResetError(null);
    try {
      const revision = await resetWorkspaceLayout();
      saveQueueRef.current = createSaveQueue(revision);
      setHydrationError(null);
      setLayoutSaveError(null);
      setHydrationStatus("ready");
    } catch (reason) {
      setLayoutResetError(formatAppError(reason, tRef.current));
      throw reason;
    } finally {
      setLayoutResetPending(false);
    }
  }, [createSaveQueue]);

  const applyWorkspaceLayoutPreset = useCallback(
    async (presetId: string) => {
      if (hydrationStatusRef.current !== "ready") return;
      const protectedContents = contentCoordinatorRef.current.listWindowOwned();
      const expectedState = {
        tree: treeRef.current,
        slots: slotsRef.current,
        focusedPaneId: focusedPaneIdRef.current,
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
          (pane) => pane.id === focusedPaneIdRef.current,
        )
          ? focusedPaneIdRef.current
          : activePanes[0].id,
        slots: slotsRef.current.map((slot) =>
          toWorkspaceLayoutSlot(slot, directories ?? []),
        ),
        documents: fileDocumentsRef.current,
        detachedContents: listPersistedDetachedContents(
          contentCoordinatorRef.current.listWindowOwned(),
          activeTree,
        ),
      });
      const plan = await planApplyWorkspaceLayoutPreset(presetId, activeLayout);
      if (
        !isWorkspaceApplyStateCurrent(expectedState, {
          tree: treeRef.current,
          slots: slotsRef.current,
          focusedPaneId: focusedPaneIdRef.current,
          detachedContents: contentCoordinatorRef.current.listWindowOwned(),
        })
      ) {
        throw new Error(tRef.current("pty.layoutChangedDuringApply"));
      }
      const restored = restoreWorkspaceLayoutApplyPlan(plan);
      const restoredSlots: PtyWorkspaceSlot[] = restored.slots;
      const restoredDocuments = [...(restored.documents ?? [])];
      const currentDocuments = fileDocumentsRef.current;
      const currentDocumentByIdentity = new Map(
        currentDocuments.map((document) => [
          `${document.directoryId}:${document.relativePath}`,
          document,
        ]),
      );
      new Set([
        ...currentDocuments.map((document) => document.id),
        ...restoredDocuments.map((document) => document.id),
      ]).forEach(invalidateFileOperationGeneration);
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

      slotsRef.current = restoredSlots;
      treeRef.current = restoredTree;
      focusedPaneIdRef.current = restored.focusedPaneId;
      setSlots(restoredSlots);
      setFileDocuments(nextDocuments);
      fileDocumentsRef.current = nextDocuments;
      setTree(restoredTree);
      setFocusedPaneId(restored.focusedPaneId);
    },
    [directories],
  );

  const commitTree = useCallback((next: WorkspaceNode) => {
    treeRef.current = next;
    setTree(next);
  }, []);

  const setFocusedPane = useCallback((paneId: string) => {
    focusedPaneIdRef.current = paneId;
    setFocusedPaneId(paneId);
  }, []);

  const getWorkspacePresentationContext = useCallback(
    (): WorkspaceContentPresentationContext => ({
      directories: directories ?? [],
      ptySlots: slotsRef.current,
      ptySessionsById: useAppStore.getState().ptySessionsById,
      fileDocuments: fileDocumentsRef.current,
      fileBuffers: fileBuffersRef.current,
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

  const openProjectFile = useCallback(
    (
      directoryId: number,
      directoryPath: string,
      relativePath: string,
    ): Promise<void> => {
      if (backupRestoreInProgressRef.current) return Promise.resolve();
      const identity = `${directoryId}:${relativePath}`;
      const pending = openingFileRequestsRef.current.get(identity);
      if (pending) return pending;
      const operation = (async () => {
        const hydrationAtStart = hydrationRequestRef.current;
        let document = fileDocumentsRef.current.find(
          (entry) =>
            entry.directoryId === directoryId &&
            entry.relativePath === relativePath,
        );
        if (!document) {
          const loaded = createWorkspaceFileBuffer(
            await openProjectFileContent(
              directoryId,
              directoryPath,
              relativePath,
            ),
          );
          if (hydrationAtStart !== hydrationRequestRef.current) {
            return;
          }
          document = {
            id: crypto.randomUUID(),
            directoryId,
            directoryPath,
            relativePath,
          };
          const nextDocuments = [...fileDocumentsRef.current, document];
          fileDocumentsRef.current = nextDocuments;
          setFileDocuments(nextDocuments);
          const nextBuffers = {
            ...fileBuffersRef.current,
            [document.id]: loaded,
          };
          fileBuffersRef.current = nextBuffers;
          setFileBuffers(nextBuffers);
        } else if (!fileBuffersRef.current[document.id]) {
          const generationAtStart = getFileOperationGeneration(document.id);
          const loaded = createWorkspaceFileBuffer(
            await openProjectFileContent(
              directoryId,
              directoryPath,
              relativePath,
            ),
          );
          const currentDocument = fileDocumentsRef.current.find(
            (entry) => entry.id === document?.id,
          );
          if (
            hydrationAtStart !== hydrationRequestRef.current ||
            generationAtStart !== getFileOperationGeneration(document.id) ||
            !currentDocument ||
            currentDocument.directoryId !== directoryId ||
            currentDocument.relativePath !== relativePath ||
            fileBuffersRef.current[document.id]
          ) {
            return;
          }
          const nextBuffers = {
            ...fileBuffersRef.current,
            [document.id]: loaded,
          };
          fileBuffersRef.current = nextBuffers;
          setFileBuffers(nextBuffers);
        }

        const detachedWindow =
          detachedFilesRef.current.get(workspaceFileKey(document.id)) ??
          pendingDetachedFilesRef.current.get(workspaceFileKey(document.id))
            ?.window;
        if (detachedWindow) {
          await detachedWindow.setFocus().catch((error: unknown) => {
            console.warn(
              "[window.set_focus_failed] 无法聚焦独立工作区窗口",
              error,
            );
          });
          return;
        }

        const ownerPane = listWorkspacePanes(treeRef.current).find((pane) =>
          hasWorkspaceContent(pane, { kind: "file", documentId: document.id }),
        );
        const pane =
          ownerPane ??
          listWorkspacePanes(treeRef.current).find(
            (entry) => entry.id === focusedPaneIdRef.current,
          ) ??
          listWorkspacePanes(treeRef.current)[0];
        focusedPaneIdRef.current = pane.id;
        setFocusedPaneId(pane.id);
        contentCoordinatorRef.current.ensureAttached(
          { kind: "file", documentId: document.id },
          { kind: "pane", windowLabel: "main", paneId: pane.id },
        );
        commitTree(
          hasWorkspaceContent(pane, { kind: "file", documentId: document.id })
            ? reduceWorkspaceTree(treeRef.current, {
                type: "activate",
                ref: { kind: "file", documentId: document.id },
                paneId: pane.id,
              })
            : addWorkspaceFileToPane(treeRef.current, pane.id, document.id),
        );
      })();
      openingFileRequestsRef.current.set(identity, operation);
      const clearPending = () => {
        if (openingFileRequestsRef.current.get(identity) === operation) {
          openingFileRequestsRef.current.delete(identity);
        }
      };
      void operation.then(clearPending, clearPending);
      return operation;
    },
    [commitTree],
  );

  const activateFile = useCallback(
    (paneId: string, documentId: string) => {
      const content = { kind: "file", documentId } as const;
      commitTree(
        reduceWorkspaceTree(treeRef.current, {
          type: "activate",
          ref: content,
          paneId,
        }),
      );
      setFocusedPane(paneId);
      syncProjectContext(content);
    },
    [commitTree, setFocusedPane, syncProjectContext],
  );

  const activateUnsupportedContent = useCallback(
    (
      paneId: string,
      content: Extract<WorkspacePaneContentRef, { kind: "unknown" }>,
    ) => {
      commitTree(
        reduceWorkspaceTree(treeRef.current, {
          type: "activate",
          ref: content,
          paneId,
        }),
      );
      setFocusedPane(paneId);
    },
    [commitTree, setFocusedPane],
  );

  const loadFile = useCallback(
    (documentId: string) =>
      fileOperationFlightsRef.current.load(documentId, async () => {
        if (fileBuffersRef.current[documentId]) return;
        const document = fileDocumentsRef.current.find(
          (entry) => entry.id === documentId,
        );
        if (!document) return;
        const generationAtStart = getFileOperationGeneration(documentId);
        const loaded = createWorkspaceFileBuffer(
          await openProjectFileContent(
            document.directoryId,
            document.directoryPath,
            document.relativePath,
          ),
        );
        const currentDocument = fileDocumentsRef.current.find(
          (entry) => entry.id === documentId,
        );
        if (
          !currentDocument ||
          currentDocument.directoryId !== document.directoryId ||
          currentDocument.relativePath !== document.relativePath ||
          generationAtStart !== getFileOperationGeneration(documentId) ||
          fileBuffersRef.current[documentId]
        ) {
          return;
        }
        const next = { ...fileBuffersRef.current, [documentId]: loaded };
        fileBuffersRef.current = next;
        setFileBuffers(next);
      }),
    [],
  );

  const editFile = useCallback((documentId: string, content: string) => {
    if (
      backupRestoreInProgressRef.current ||
      isHandoffActive(
        contentCoordinatorRef.current.get({ kind: "file", documentId }),
      )
    ) {
      return;
    }
    const buffer = fileBuffersRef.current[documentId];
    if (!buffer) return;
    const next = {
      ...fileBuffersRef.current,
      [documentId]: editWorkspaceFileBuffer(buffer, content),
    };
    fileBuffersRef.current = next;
    setFileBuffers(next);
  }, []);

  const reloadFile = useCallback(
    (documentId: string) =>
      fileOperationFlightsRef.current.load(documentId, async () => {
        await fileOperationFlightsRef.current.waitForSave(documentId);
        const document = fileDocumentsRef.current.find(
          (entry) => entry.id === documentId,
        );
        const startingBuffer = fileBuffersRef.current[documentId];
        if (!document || !startingBuffer) return;
        const generationAtStart = getFileOperationGeneration(documentId);
        try {
          const loaded = createWorkspaceFileBuffer(
            await openProjectFileContent(
              document.directoryId,
              document.directoryPath,
              document.relativePath,
            ),
            startingBuffer.epoch + 1,
          );
          const currentDocument = fileDocumentsRef.current.find(
            (entry) => entry.id === documentId,
          );
          const currentBuffer = fileBuffersRef.current[documentId];
          if (
            !currentDocument ||
            currentDocument.directoryId !== document.directoryId ||
            currentDocument.relativePath !== document.relativePath ||
            !currentBuffer ||
            currentBuffer.epoch !== startingBuffer.epoch ||
            currentBuffer.version !== startingBuffer.version ||
            generationAtStart !== getFileOperationGeneration(documentId)
          ) {
            return;
          }
          const next = { ...fileBuffersRef.current, [documentId]: loaded };
          fileBuffersRef.current = next;
          setFileBuffers(next);
        } catch (reason) {
          if (isProjectIdentityChangedError(reason)) {
            const current = fileBuffersRef.current[documentId];
            if (current) {
              const next = {
                ...fileBuffersRef.current,
                [documentId]: markWorkspaceFileIdentityChanged(current),
              };
              fileBuffersRef.current = next;
              setFileBuffers(next);
            }
            toast.error(tRef.current("workspaceFiles.projectIdentityChanged"));
            return;
          }
          toast.error(formatAppError(reason, tRef.current));
        }
      }),
    [],
  );

  const saveFile = useCallback(
    (documentId: string) =>
      fileOperationFlightsRef.current.save(documentId, async () => {
        if (
          backupRestoreInProgressRef.current ||
          isHandoffActive(
            contentCoordinatorRef.current.get({ kind: "file", documentId }),
          )
        ) {
          return;
        }
        const document = fileDocumentsRef.current.find(
          (entry) => entry.id === documentId,
        );
        const buffer = fileBuffersRef.current[documentId];
        if (
          !document ||
          !buffer ||
          buffer.kind !== "text" ||
          buffer.identityChanged === true ||
          buffer.content === buffer.savedContent ||
          buffer.saving
        ) {
          return;
        }
        const submitted = beginWorkspaceFileSave(buffer);
        fileBuffersRef.current = {
          ...fileBuffersRef.current,
          [documentId]: submitted,
        };
        setFileBuffers(fileBuffersRef.current);
        const saveCommitDisposition = () => {
          const currentDocument = fileDocumentsRef.current.find(
            (entry) => entry.id === documentId,
          );
          const currentBuffer = fileBuffersRef.current[documentId];
          return resolveWorkspaceFileSaveCommitDisposition(
            currentBuffer,
            submitted,
            Boolean(
              currentDocument &&
              currentDocument.directoryId === document.directoryId &&
              currentDocument.relativePath === document.relativePath,
            ),
          );
        };
        try {
          const result = await saveProjectTextFile(
            document.directoryId,
            document.directoryPath,
            document.relativePath,
            submitted.content,
            submitted.revision,
          );
          const disposition = saveCommitDisposition();
          if (disposition === "discard-result") return;
          if (disposition === "restore-saving-state") {
            const current = fileBuffersRef.current[documentId];
            if (!current) return;
            const next = {
              ...fileBuffersRef.current,
              [documentId]: failWorkspaceFileSave(current, submitted),
            };
            fileBuffersRef.current = next;
            setFileBuffers(next);
            return;
          }
          if (result.kind === "conflict") {
            const current = fileBuffersRef.current[documentId];
            if (!current) return;
            const next = {
              ...fileBuffersRef.current,
              [documentId]: markWorkspaceFileSaveConflict(current, submitted),
            };
            fileBuffersRef.current = next;
            setFileBuffers(next);
            toast.error(tRef.current("workspaceFiles.saveConflict"), {
              action: {
                label: tRef.current("workspaceFiles.reload"),
                onClick: () => void reloadFile(documentId),
              },
            });
            return;
          }
          const current = fileBuffersRef.current[documentId];
          if (!current) return;
          const next = {
            ...fileBuffersRef.current,
            [documentId]: completeWorkspaceFileSave(current, submitted, result),
          };
          fileBuffersRef.current = next;
          setFileBuffers(next);
          if (result.warning === "permissionsNotRestored") {
            toast.warning(
              tRef.current("workspaceFiles.permissionsNotRestored"),
            );
          }
        } catch (reason) {
          if (saveCommitDisposition() === "discard-result") return;
          const current = fileBuffersRef.current[documentId];
          if (!current) return;
          if (isProjectIdentityChangedError(reason)) {
            const next = {
              ...fileBuffersRef.current,
              [documentId]: markWorkspaceFileIdentityChanged(current),
            };
            fileBuffersRef.current = next;
            setFileBuffers(next);
            toast.error(tRef.current("workspaceFiles.projectIdentityChanged"));
            return;
          }
          const next = {
            ...fileBuffersRef.current,
            [documentId]: failWorkspaceFileSave(current, submitted),
          };
          fileBuffersRef.current = next;
          setFileBuffers(next);
          toast.error(formatAppError(reason, tRef.current));
        }
      }),
    [reloadFile],
  );

  const detachFile = useCallback(
    async (documentId: string) => {
      const content = { kind: "file", documentId } as const;
      if (isWindowOwned(contentCoordinatorRef.current.get(content))) {
        return;
      }
      const sourcePane = listWorkspacePanes(treeRef.current).find((pane) =>
        hasWorkspaceContent(pane, content),
      );
      if (!sourcePane)
        throw new Error(tRef.current("workspaceFiles.loadingFile"));
      const token = crypto.randomUUID();
      const windowLabel = createWindowLabel("workspaceContent");
      let grantedWindowLabel: string | undefined;
      let lifecycleStarted = false;
      try {
        const lifecycle = contentCoordinatorRef.current.beginDetach(
          content,
          { kind: "pane", windowLabel: "main", paneId: sourcePane.id },
          { kind: "window", windowLabel },
          token,
        );
        if (lifecycle?.outcome !== "changed") {
          throw new Error(tRef.current("pty.detachedMoveUnavailable"));
        }
        lifecycleStarted = true;
        grantedWindowLabel = windowLabel;
        if (!fileBuffersRef.current[documentId]) await loadFile(documentId);
        await fileOperationFlightsRef.current.waitForSave(documentId);
        const fileBuffer = fileBuffersRef.current[documentId];
        const fileDocument = fileDocumentsRef.current.find(
          (document) => document.id === documentId,
        );
        if (!fileDocument || !fileBuffer || fileBuffer.saving) {
          throw new Error(tRef.current("workspaceFiles.loadingFile"));
        }
        await grantContentWindowFile(
          windowLabel,
          fileDocument.directoryId,
          fileDocument.directoryPath,
          fileDocument.relativePath,
        );
        const childUrl = new URL(window.location.href);
        childUrl.search = "";
        childUrl.hash = "";
        childUrl.searchParams.set("detachedFileId", documentId);
        childUrl.searchParams.set("fileHandoffToken", token);
        childUrl.searchParams.set("sourcePaneId", sourcePane.id);
        await new Promise<void>((resolve, reject) => {
          const child = createWorkspaceContentWindow({
            label: windowLabel,
            url: `${childUrl.pathname}${childUrl.search}${childUrl.hash}`,
            title:
              fileDocument.relativePath.split("/").pop() ??
              fileDocument.relativePath,
          });
          const failCreation = (reason: unknown) => {
            const pending = takePendingWorkspaceContentWindow(
              pendingDetachedFilesRef.current,
              workspaceFileKey(documentId),
              windowLabel,
            );
            if (!pending) return;
            reject(new Error(formatAppError(reason, tRef.current)));
          };
          const cleanupCreationErrorListener = retainAsyncUnlisten(
            () =>
              child.once("tauri://error", (event) => {
                failCreation(
                  event.payload == null
                    ? tRef.current("pty.detachedCreateFailed")
                    : event.payload,
                );
              }),
            failCreation,
          );
          registerPendingWorkspaceContentWindow({
            pending: pendingDetachedFilesRef.current,
            key: workspaceFileKey(documentId),
            timeoutMs: WORKSPACE_CONTENT_WINDOW_HANDOFF_TIMEOUT_MS,
            onTimeout: () => {
              void child.destroy().catch(() => undefined);
              reject(new Error(tRef.current("pty.detachedStartTimedOut")));
            },
            record: {
              documentId,
              token,
              windowLabel,
              sourcePaneId: sourcePane.id,
              window: child,
              cleanup: cleanupCreationErrorListener,
              resolve,
              reject,
              kind: "file",
              stage: initialPendingStage("file"),
            },
          });
        });
      } catch (reason) {
        if (grantedWindowLabel) {
          await revokeContentWindowFile(grantedWindowLabel).catch(
            (revokeError) =>
              console.warn(
                "Unable to revoke failed file window grant",
                revokeError,
              ),
          );
        }
        if (lifecycleStarted && token) {
          contentCoordinatorRef.current.failHandoff(
            content,
            "detachFailed",
            token,
          );
        }
        throw reason;
      }
    },
    [loadFile],
  );

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
      const pane = findWorkspacePane(treeRef.current, paneId);
      if (!pane) return;
      setFocusedPane(paneId);
      if (pane.activeContent) syncProjectContext(pane.activeContent);
    },
    [setFocusedPane, syncProjectContext],
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
      const removedSlot = slotsRef.current.find(
        (slot) => slot.instanceId === instanceId,
      );
      detachedByInstanceRef.current.delete(workspacePtyKey(instanceId));
      const nextSlots = slotsRef.current.filter(
        (slot) => slot.instanceId !== instanceId,
      );
      if (removedSlot?.sessionId) removePtySession(removedSlot.sessionId);
      slotsRef.current = nextSlots;
      setSlots(nextSlots);
      const nextTree = reduceWorkspaceTree(treeRef.current, {
        type: "close",
        refs: [content],
        origin: "window",
      });
      commitTree(nextTree);
      if (!findWorkspacePane(nextTree, focusedPaneIdRef.current)) {
        setFocusedPane(listWorkspacePanes(nextTree)[0].id);
      }
    },
    [commitTree, removePtySession, setFocusedPane],
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

  const closeContents = useCallback(
    async (
      requestedContents: WorkspacePaneContentRef[],
      origin: "tab" | "menu" | "stack" | "window",
      onApproved?: () => void,
    ) => {
      const uniqueContents: WorkspacePaneContentRef[] = [
        ...new Map(
          requestedContents.map((content) => [
            workspaceContentReactKey(content),
            content,
          ]),
        ).values(),
      ];
      const ptySessionsById = useAppStore.getState().ptySessionsById;
      type WorkspaceCloseTarget = {
        content: WorkspacePaneContentRef;
        slot?: PtyWorkspaceSlot;
        beforeClose: () => boolean;
        describeDisposalImpact: () => WorkspaceContentDisposalImpact[];
      };
      const closeTargets: WorkspaceCloseTarget[] = [];
      for (const content of uniqueContents) {
        const pane = listWorkspacePanes(treeRef.current).find((candidate) =>
          hasWorkspaceContent(candidate, content),
        );
        if (!pane) continue;

        if (content.kind === "pty") {
          const slot = slotsRef.current.find(
            (candidate) => candidate.instanceId === content.slotId,
          );
          if (
            !slot ||
            isWindowOwned(contentCoordinatorRef.current.get(content))
          ) {
            continue;
          }
          const session = slot.sessionId
            ? ptySessionsById[slot.sessionId]
            : undefined;
          const title = presentWorkspaceContent(
            content,
            getWorkspacePresentationContext(),
          ).title;
          const adapter = tryGetWorkspaceContentAdapter("pty");
          contentCoordinatorRef.current.ensureAttached(content, {
            kind: "pane",
            windowLabel: "main",
            paneId: pane.id,
          });
          closeTargets.push({
            content,
            slot,
            beforeClose: () =>
              shouldCloseWorkspaceContent(adapter?.lifecycle?.beforeClose, {
                isDirty: false,
                confirmDiscard: () => false,
              }),
            describeDisposalImpact: () =>
              adapter?.lifecycle?.describeDisposalImpact?.({
                isDirty: false,
                isRunning: session?.state === "running",
                title,
              }) ??
              (session?.state === "running"
                ? [{ kind: "runningPty", title }]
                : []),
          });
          continue;
        }

        if (content.kind === "unknown") {
          closeTargets.push({
            content,
            beforeClose: () => true,
            describeDisposalImpact: () => [],
          });
          continue;
        }

        const document = fileDocumentsRef.current.find(
          (candidate) => candidate.id === content.documentId,
        );
        if (
          !document ||
          isWindowOwned(contentCoordinatorRef.current.get(content)) ||
          isHandoffActive(contentCoordinatorRef.current.get(content))
        ) {
          continue;
        }
        const buffer = fileBuffersRef.current[content.documentId];
        const isDirty = Boolean(
          buffer &&
          (buffer.content !== buffer.savedContent ||
            buffer.saving ||
            buffer.conflict === true ||
            buffer.identityChanged === true),
        );
        const adapter = tryGetWorkspaceContentAdapter("file");
        contentCoordinatorRef.current.ensureAttached(content, {
          kind: "pane",
          windowLabel: "main",
          paneId: pane.id,
        });
        closeTargets.push({
          content,
          beforeClose: () =>
            shouldCloseWorkspaceContent(adapter?.lifecycle?.beforeClose, {
              isDirty,
              confirmDiscard: () => false,
            }),
          describeDisposalImpact: () =>
            adapter?.lifecycle?.describeDisposalImpact?.({
              isDirty,
              isRunning: false,
              title: document.relativePath,
            }) ??
            (isDirty
              ? [{ kind: "dirtyFile", title: document.relativePath }]
              : []),
        });
      }
      if (closeTargets.length === 0) return;

      const outcomes: Array<{
        slot: PtyWorkspaceSlot;
        result: "closed" | "pending" | "cancelled" | "terminating";
      }> = [];
      try {
        await closeWorkspaceContentBatch({
          coordinator: contentCoordinatorRef.current,
          requestId: crypto.randomUUID(),
          requests: closeTargets,
          confirmImpacts: confirmCloseImpacts,
          onApproved,
          dispose: (context) => {
            if (context.content.kind === "pty") {
              return tryGetWorkspaceContentAdapter("pty")?.lifecycle?.dispose?.(
                context as WorkspaceContentDisposeContext<"pty">,
              );
            }
            if (context.content.kind === "unknown") return;
            return tryGetWorkspaceContentAdapter("file")?.lifecycle?.dispose?.(
              context as WorkspaceContentDisposeContext<"file">,
            );
          },
          execute: async () => {
            const closedContents: WorkspacePaneContentRef[] = [];
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
                  treeRef.current,
                ),
              );
              closedContents.push(...unsupportedContents);
            }
            const fileIds = closeTargets.flatMap((target) =>
              target.content.kind === "file" ? [target.content.documentId] : [],
            );
            if (fileIds.length > 0) {
              const next = closeWorkspaceFileState(
                {
                  tree: treeRef.current,
                  documents: fileDocumentsRef.current,
                  buffers: fileBuffersRef.current,
                },
                fileIds,
              );
              commitTree(next.tree);
              fileDocumentsRef.current = next.documents;
              setFileDocuments(next.documents);
              fileBuffersRef.current = next.buffers;
              setFileBuffers(next.buffers);
              next.closedDocumentIds.forEach(invalidateFileOperationGeneration);
              closedContents.push(
                ...next.closedDocumentIds.map((documentId) => ({
                  kind: "file" as const,
                  documentId,
                })),
              );
            }

            const ptyTargets = closeTargets.flatMap((target) =>
              target.content.kind === "pty"
                ? [{ slot: target.slot!, content: target.content }]
                : [],
            );
            const results = await Promise.all(
              ptyTargets.map(async ({ slot, content }) => {
                if (slot.restoredState) {
                  return { slot, content, result: "closed" as const };
                }
                const terminal = terminalRefs.current.get(slot.instanceId);
                if (!terminal) {
                  return { slot, content, result: "cancelled" as const };
                }
                try {
                  return {
                    slot,
                    content,
                    result: await terminal.closeSession(false),
                  };
                } catch {
                  return { slot, content, result: "cancelled" as const };
                }
              }),
            );
            outcomes.push(
              ...results.map(({ slot, result }) => ({ slot, result })),
            );
            for (const result of results) {
              if (result.result === "closed") {
                removeSlot(result.slot.instanceId, {
                  disposeOwnerEnded: false,
                });
                closedContents.push(result.content);
              }
            }
            return {
              closed: closedContents,
              pending: results.flatMap(({ content, result }) =>
                result === "pending" || result === "terminating"
                  ? [content]
                  : [],
              ),
            };
          },
        });
      } catch (reason) {
        console.error(
          `Failed to close workspace contents from ${origin}`,
          reason,
        );
      }

      const pendingCount = outcomes.filter(
        (outcome) =>
          outcome.result === "pending" || outcome.result === "terminating",
      ).length;
      const failedCount = outcomes.filter(
        (outcome) => outcome.result === "cancelled",
      ).length;
      if (pendingCount > 0) {
        toast.info(tRef.current("pty.closePending", { count: pendingCount }));
      }
      if (failedCount > 0) {
        toast.error(
          tRef.current("pty.closeFailedMany", { count: failedCount }),
        );
      }
    },
    [commitTree, confirmCloseImpacts, directories, removeSlot],
  );

  const launchSession = useCallback(
    (directoryId: number, toolKey: ToolKey, resumeSessionId?: string) => {
      if (backupRestoreInProgressRef.current) return;
      const directory = directories?.find((entry) => entry.id === directoryId);
      if (!directory) {
        toast.error(tRef.current("pty.projectUnavailable"));
        return;
      }
      const currentSlots = slotsRef.current;
      const sequence = nextWorkspaceSessionSequence(
        currentSlots,
        directoryId,
        toolKey,
      );
      const slot: PtyWorkspaceSlot = {
        instanceId: crypto.randomUUID(),
        directoryId,
        directoryPath: directory.path,
        projectName: directory.name,
        toolKey,
        sequence,
        title: { kind: "automatic" },
        resumeSessionId,
      };
      const nextSlots = [...currentSlots, slot];
      slotsRef.current = nextSlots;
      setSlots(nextSlots);

      const panes = listWorkspacePanes(treeRef.current);
      const targetPane =
        findWorkspacePane(treeRef.current, focusedPaneIdRef.current) ??
        panes[0];
      contentCoordinatorRef.current.ensureAttached(
        { kind: "pty", slotId: slot.instanceId },
        { kind: "pane", windowLabel: "main", paneId: targetPane.id },
      );
      commitTree(
        addSessionToWorkspacePane(
          treeRef.current,
          targetPane.id,
          slot.instanceId,
        ),
      );
      setFocusedPane(targetPane.id);
    },
    [commitTree, directories, setFocusedPane],
  );

  const activateSession = useCallback(
    (paneId: string, instanceId: string) => {
      const content = { kind: "pty", slotId: instanceId } as const;
      try {
        commitTree(
          reduceWorkspaceTree(treeRef.current, {
            type: "activate",
            ref: content,
            paneId,
          }),
        );
      } catch {
        return;
      }
      setFocusedPane(paneId);
      syncProjectContext(content);
    },
    [commitTree, setFocusedPane, syncProjectContext],
  );

  const splitPane = useCallback(
    (paneId: string, direction: SplitDirection) => {
      const sourcePane = findWorkspacePane(treeRef.current, paneId);
      if (!sourcePane) return;
      if (sourcePane.activeContent)
        syncProjectContext(sourcePane.activeContent);
      const newPaneId = crypto.randomUUID();
      const next = splitWorkspacePane(
        treeRef.current,
        paneId,
        direction,
        crypto.randomUUID(),
        newPaneId,
      );
      commitTree(next);
      setFocusedPane(newPaneId);
    },
    [commitTree, setFocusedPane, syncProjectContext],
  );

  const splitAndMoveContent = useCallback(
    (
      paneId: string,
      content: WorkspacePaneContentRef,
      direction: SplitDirection,
    ) => {
      if (content.kind === "unknown") return;
      const sourcePane = findWorkspacePane(treeRef.current, paneId);
      if (!sourcePane || !hasWorkspaceContent(sourcePane, content)) return;
      const ownerState = contentCoordinatorRef.current.ensureAttached(content, {
        kind: "pane",
        windowLabel: "main",
        paneId: sourcePane.id,
      });
      if (!canChangeWorkspaceContentPane(ownerState)) return;
      const newPaneId = crypto.randomUUID();
      const next = reduceWorkspaceTree(treeRef.current, {
        type: "split",
        ref: content,
        toPaneId: newPaneId,
        direction,
        splitId: crypto.randomUUID(),
      });
      if (next === treeRef.current) return;
      contentCoordinatorRef.current.ensureAttached(content, {
        kind: "pane",
        windowLabel: "main",
        paneId: newPaneId,
      });
      commitTree(next);
      setFocusedPane(newPaneId);
      syncProjectContext(content);
    },
    [commitTree, setFocusedPane, syncProjectContext],
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
      if (content.kind === "unknown") return;
      const sourcePane = findWorkspacePane(treeRef.current, sourcePaneId);
      const destinationPane = findWorkspacePane(
        treeRef.current,
        destinationPaneId,
      );
      if (
        !sourcePane ||
        !hasWorkspaceContent(sourcePane, content) ||
        !destinationPane ||
        sourcePaneId === destinationPaneId
      ) {
        return;
      }
      const ownerState = contentCoordinatorRef.current.ensureAttached(content, {
        kind: "pane",
        windowLabel: "main",
        paneId: sourcePane.id,
      });
      if (!canChangeWorkspaceContentPane(ownerState)) return;
      const next = reduceWorkspaceTree(treeRef.current, {
        type: "move",
        ref: content,
        toPaneId: destinationPaneId,
      });
      if (next === treeRef.current) return;
      contentCoordinatorRef.current.ensureAttached(content, {
        kind: "pane",
        windowLabel: "main",
        paneId: destinationPaneId,
      });
      commitTree(next);
      setFocusedPane(destinationPaneId);
      syncProjectContext(content);
    },
    [commitTree, setFocusedPane, syncProjectContext],
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

  const isManagedDetachedDrag = useCallback(
    (instanceId: string, windowLabel: string) => {
      const ownership = contentCoordinatorRef.current.get({
        kind: "pty",
        slotId: instanceId,
      });
      return (
        ownership?.phase === "detached" &&
        ownership.owner.kind === "window" &&
        ownership.owner.windowLabel === windowLabel
      );
    },
    [],
  );
  const isManagedDetachedFileDrag = useCallback(
    (documentId: string, windowLabel: string) => {
      const ownership = contentCoordinatorRef.current.get({
        kind: "file",
        documentId,
      });
      return (
        ownership?.phase === "detached" &&
        ownership.owner.kind === "window" &&
        ownership.owner.windowLabel === windowLabel
      );
    },
    [],
  );

  const reconcileTimedOutDetach = useCallback(
    async (pending: PendingDetachedWindow) => {
      const key = workspacePtyKey(pending.instanceId);
      const current = pendingDetachedRef.current.get(key);
      if (current && current.windowLabel !== pending.windowLabel) return;
      if (current) window.clearTimeout(current.timer);
      let tracked: PendingDetachedWindow;
      const timer = window.setTimeout(() => {
        if (pendingDetachedRef.current.get(key) === tracked) {
          pendingDetachedRef.current.delete(key);
          void reconcileTimedOutDetach(tracked);
        }
      }, PTY_OWNER_QUERY_RETRY_DELAY_MS);
      tracked = { ...(current ?? pending), timer };
      pendingDetachedRef.current.set(key, tracked);

      const [status, child] = await Promise.all([
        getPtySessionWindowStatus(pending.sessionId).catch(() => null),
        WebviewWindow.getByLabel(pending.windowLabel).catch(() => null),
      ]);
      if (pendingDetachedRef.current.get(key) !== tracked) return;
      const action = resolveDetachedStartTimeoutAction(status, {
        expectedChildLabel: pending.windowLabel,
        childExists: Boolean(child),
      });

      let effectiveAction = action;
      if (action === "retry-owner-query") {
        const step = nextOwnerQueryStep(tracked.ownerQueryRetries ?? 0);
        if (step.kind === "retry") {
          tracked.ownerQueryRetries = step.retries;
          console.warn(
            `Unable to verify PTY detach owner for session ${pending.sessionId}; retry ${step.retries} of ${PTY_OWNER_QUERY_MAX_RETRIES} without closing either window.`,
          );
          return;
        }
        console.warn(
          `Giving up verifying PTY detach owner for session ${pending.sessionId}; rolling the detach back.`,
        );
        effectiveAction = "cancel-source-handoff";
      }

      if (effectiveAction === "accept-detached-owner") {
        if (!advancePendingWindowStage(tracked, "attachedAck")) return;
        const ownership = contentCoordinatorRef.current.completeHandoff(
          { kind: "pty", slotId: pending.instanceId },
          "detachReady",
          pending.token,
        );
        if (ownership?.outcome !== "changed") {
          await rollbackWorkspaceContentHandoff(
            pending.handoffContext,
            pending.handoffPayload,
            new Error(tRef.current("pty.detachedStateChanged")),
          ).catch(() => undefined);
          takePendingWorkspaceContentWindow(
            pendingDetachedRef.current,
            workspacePtyKey(pending.instanceId),
            pending.windowLabel,
          );
          pending.reject(new Error(tRef.current("pty.detachedStateChanged")));
          return;
        }
        const promoted = takePendingWorkspaceContentWindow(
          pendingDetachedRef.current,
          workspacePtyKey(pending.instanceId),
          pending.windowLabel,
        );
        if (!promoted) return;
        detachedByInstanceRef.current.set(
          workspacePtyKey(pending.instanceId),
          pending.window,
        );
        const content = {
          kind: "pty",
          slotId: pending.instanceId,
        } as const;
        const nextTree = reduceWorkspaceTree(treeRef.current, {
          type: "detach",
          ref: content,
        });
        commitTree(nextTree);
        if (!findWorkspacePane(nextTree, focusedPaneIdRef.current)) {
          setFocusedPane(listWorkspacePanes(nextTree)[0].id);
        }
        pending.resolve();
        return;
      }

      takePendingWorkspaceContentWindow(
        pendingDetachedRef.current,
        workspacePtyKey(pending.instanceId),
        pending.windowLabel,
      );
      if (effectiveAction === "remove-ended-session") {
        void pending.window.destroy().catch(() => undefined);
        contentCoordinatorRef.current.failHandoff(
          { kind: "pty", slotId: pending.instanceId },
          "detachFailed",
          pending.token,
        );
        pending.reject(new Error(tRef.current("pty.detachedStartFailed")));
        removeSlot(pending.instanceId);
        return;
      }

      const failureMessage =
        effectiveAction === "reject-foreign-owner"
          ? tRef.current("pty.detachedStateChanged")
          : tRef.current("pty.detachedStartTimedOut");
      await rollbackWorkspaceContentHandoff(
        pending.handoffContext,
        pending.handoffPayload,
        new Error(failureMessage),
      ).catch(() => undefined);
      contentCoordinatorRef.current.failHandoff(
        { kind: "pty", slotId: pending.instanceId },
        "detachFailed",
        pending.token,
      );
      void pending.window.destroy().catch(() => undefined);
      pending.reject(new Error(failureMessage));
    },
    [commitTree, removeSlot, setFocusedPane],
  );

  const detachSession = useCallback(
    async (instanceId: string) => {
      const slot = slotsRef.current.find(
        (candidate) => candidate.instanceId === instanceId,
      );
      const sessionId = slot?.sessionId;
      if (
        !slot ||
        !sessionId ||
        isWindowOwned(
          contentCoordinatorRef.current.get({
            kind: "pty",
            slotId: instanceId,
          }),
        )
      ) {
        throw new Error(tRef.current("pty.detachedMoveUnavailable"));
      }
      const currentSession = useAppStore.getState().ptySessionsById[sessionId];
      if (currentSession?.state !== "running") {
        throw new Error(tRef.current("pty.detachedMoveNotRunning"));
      }
      const terminal = terminalRefs.current.get(instanceId);
      if (!terminal) throw new Error(tRef.current("pty.terminalNotReady"));

      const windowLabel = createWindowLabel("terminal");
      const sourcePane = listWorkspacePanes(treeRef.current).find((pane) =>
        hasWorkspaceContent(pane, { kind: "pty", slotId: instanceId }),
      );
      if (!sourcePane)
        throw new Error(tRef.current("pty.detachedMoveUnavailable"));
      const content = { kind: "pty", slotId: instanceId } as const;
      const source = {
        kind: "pane",
        windowLabel: "main",
        paneId: sourcePane.id,
      } as const;
      const target = { kind: "window", windowLabel } as const;
      const ownerState = contentCoordinatorRef.current.ensureAttached(
        content,
        source,
      );
      if (ownerState.phase !== "attached") {
        throw new Error(tRef.current("pty.terminating"));
      }
      let driverContext: WorkspaceContentHandoffHookContext<"pty"> = {
        content,
        source,
        target,
        transferId: crypto.randomUUID(),
        capabilities: {
          prepare: async () => ({ handoff: await terminal.captureHandoff() }),
          attach: async (payload) => {
            await terminal.attachHandoff(sessionId, payload.handoff.token);
          },
          rollback: async (payload) => {
            if (payload) await terminal.cancelHandoff(payload.handoff.token);
          },
        },
      };
      const prepared = await prepareWorkspaceContentHandoff(driverContext);
      driverContext = { ...driverContext, transferId: prepared.transferId };
      const handoff = prepared.payload.handoff;
      const lifecycle = contentCoordinatorRef.current.beginDetach(
        content,
        source,
        target,
        prepared.transferId,
      );
      if (lifecycle?.outcome !== "changed") {
        await rollbackWorkspaceContentHandoff(
          driverContext,
          prepared.payload,
          new Error(tRef.current("pty.detachedMoveUnavailable")),
        ).catch(() => undefined);
        throw new Error(tRef.current("pty.detachedMoveUnavailable"));
      }
      const detachedRecord = { instanceId, sessionId, windowLabel };
      const title = presentWorkspaceContent(
        { kind: "pty", slotId: instanceId },
        getWorkspacePresentationContext(),
      ).title;
      const childUrl = new URL(window.location.href);
      childUrl.search = "";
      childUrl.hash = "";
      childUrl.searchParams.set("detachedSessionId", sessionId);
      childUrl.searchParams.set("handoffToken", handoff.token);
      childUrl.searchParams.set("instanceId", instanceId);
      childUrl.searchParams.set("detachedTitle", title);
      childUrl.searchParams.set("detachedToolKey", slot.toolKey);
      childUrl.searchParams.set("sourcePaneId", sourcePane.id);

      try {
        await new Promise<void>((resolve, reject) => {
          const child = createWorkspaceContentWindow({
            label: windowLabel,
            url: `${childUrl.pathname}${childUrl.search}${childUrl.hash}`,
            title,
          });
          const failCreation = (reason: unknown) => {
            const pending = takePendingWorkspaceContentWindow(
              pendingDetachedRef.current,
              workspacePtyKey(instanceId),
              windowLabel,
            );
            if (!pending) return;
            reject(new Error(formatAppError(reason, tRef.current)));
          };
          const cleanupCreationErrorListener = retainAsyncUnlisten(
            () =>
              child.once("tauri://error", (event) => {
                failCreation(
                  event.payload == null
                    ? tRef.current("pty.detachedCreateFailed")
                    : event.payload,
                );
              }),
            failCreation,
          );
          registerPendingWorkspaceContentWindow({
            pending: pendingDetachedRef.current,
            key: workspacePtyKey(instanceId),
            timeoutMs: WORKSPACE_CONTENT_WINDOW_HANDOFF_TIMEOUT_MS,
            onTimeout: (pending) => {
              void reconcileTimedOutDetach(pending);
            },
            record: {
              ...detachedRecord,
              kind: "pty",
              stage: initialPendingStage("pty"),
              token: handoff.token,
              resolve,
              reject,
              window: child,
              cleanup: cleanupCreationErrorListener,
              handoffContext: driverContext,
              handoffPayload: prepared.payload,
            },
          });
        });
      } catch (reason) {
        await rollbackWorkspaceContentHandoff(
          driverContext,
          prepared.payload,
          reason,
        ).catch(() => undefined);
        contentCoordinatorRef.current.failHandoff(
          { kind: "pty", slotId: instanceId },
          "detachFailed",
          prepared.transferId,
        );
        throw reason;
      }
    },
    [directories, reconcileTimedOutDetach, terminalRefs],
  );

  const handleDetachedReady = useCallback(
    (payload: DetachedWindowReadyEvent) => {
      const pending = pendingDetachedRef.current.get(
        workspacePtyKey(payload.instanceId),
      );
      if (!pending || !matchesDetachedWindow(pending, payload)) {
        return;
      }
      if (!advancePendingWindowStage(pending, "attachedAck")) return;
      const ownership = contentCoordinatorRef.current.completeHandoff(
        { kind: "pty", slotId: payload.instanceId },
        "detachReady",
        pending.token,
      );
      if (ownership?.outcome !== "changed") {
        void rollbackWorkspaceContentHandoff(
          pending.handoffContext,
          pending.handoffPayload,
          new Error(tRef.current("pty.detachedStateChanged")),
        ).catch(() => undefined);
        takePendingWorkspaceContentWindow(
          pendingDetachedRef.current,
          workspacePtyKey(payload.instanceId),
          pending.windowLabel,
        );
        pending.reject(new Error(tRef.current("pty.detachedStateChanged")));
        void pending.window.destroy().catch(() => undefined);
        return;
      }
      promotePendingWorkspaceContentWindow({
        pending: pendingDetachedRef.current,
        detached: detachedByInstanceRef.current,
        key: workspacePtyKey(payload.instanceId),
        expectedWindowLabel: pending.windowLabel,
        toDetached: (record) => record.window,
      });
      const content = { kind: "pty", slotId: payload.instanceId } as const;
      const nextTree = reduceWorkspaceTree(treeRef.current, {
        type: "detach",
        ref: content,
      });
      commitTree(nextTree);
      if (!findWorkspacePane(nextTree, focusedPaneIdRef.current)) {
        setFocusedPane(listWorkspacePanes(nextTree)[0].id);
      }
      pending.resolve();
    },
    [commitTree, setFocusedPane],
  );

  const handleDetachedFailed = useCallback(
    (payload: DetachedWindowReadyEvent & { message?: string }) => {
      const pending = pendingDetachedRef.current.get(
        workspacePtyKey(payload.instanceId),
      );
      if (!pending || !matchesDetachedWindow(pending, payload)) return;
      void rollbackWorkspaceContentHandoff(
        pending.handoffContext,
        pending.handoffPayload,
        new Error(payload.message || tRef.current("pty.detachedStartFailed")),
      ).catch(() => undefined);
      contentCoordinatorRef.current.failHandoff(
        { kind: "pty", slotId: payload.instanceId },
        "detachFailed",
        pending.token,
      );
      takePendingWorkspaceContentWindow(
        pendingDetachedRef.current,
        workspacePtyKey(payload.instanceId),
        pending.windowLabel,
      );
      pending.reject(
        new Error(payload.message || tRef.current("pty.detachedStartFailed")),
      );
      void pending.window.destroy().catch(() => undefined);
    },
    [],
  );

  // 文件独立窗被销毁（崩溃或被强制关闭）后，Rust 通知主窗口：只回收 coordinator 认为
  // “由该窗口持有（detached）”的文件。正常返回/关闭之后窗口同样会触发 Destroyed，
  // 此时状态已不是 detached，函数直接返回。顺序固定：ownerEnded → 删句柄 → ensureAttached
  // → 一次 commitTree；镜像到主窗口的 buffer 原样保留，不读盘、不弹提示。
  const handleWorkspaceContentWindowLost = useCallback(
    ({ windowLabel }: WorkspaceContentWindowLostEvent) => {
      const coordinator = contentCoordinatorRef.current;
      const lost = coordinator.listWindowOwned().filter((content) => {
        if (content.kind !== "file") return false;
        const state = coordinator.get(content);
        return (
          state?.phase === "detached" &&
          state.owner.kind === "window" &&
          state.owner.windowLabel === windowLabel
        );
      });
      if (lost.length === 0) return;
      const targetPane =
        findWorkspacePane(treeRef.current, focusedPaneIdRef.current) ??
        listWorkspacePanes(treeRef.current)[0];
      let nextTree = treeRef.current;
      for (const content of lost) {
        if (content.kind !== "file") continue;
        coordinator.ownerEnded(content);
        detachedFilesRef.current.delete(workspaceFileKey(content.documentId));
        coordinator.ensureAttached(content, {
          kind: "pane",
          windowLabel: "main",
          paneId: targetPane.id,
        });
        nextTree = addWorkspaceFileToPane(
          nextTree,
          targetPane.id,
          content.documentId,
        );
      }
      commitTree(nextTree);
    },
    [commitTree],
  );

  const handlePtySessionOwnerLost = useCallback(
    async ({ sessionId }: PtySessionOwnerLostEvent) => {
      if (ownerLostRecoveriesRef.current.has(sessionId)) {
        console.warn(
          `PTY owner-lost recovery already running for session ${sessionId}; ignoring duplicate event.`,
        );
        return;
      }
      ownerLostRecoveriesRef.current.add(sessionId);
      const signal = lifecycleAbortRef.current.signal;
      try {
        const outcome = await retryWithBackoff<PtyOwnerLostAttemptResult>(
          async () => {
            const slot = slotsRef.current.find(
              (candidate) => candidate.sessionId === sessionId,
            );
            if (!slot) return { kind: "slot-gone" };
            const terminal = terminalRefs.current.get(slot.instanceId);
            if (!terminal || hydrationStatusRef.current !== "ready") {
              throw new Error(
                "PTY terminal is not ready for owner-lost recovery",
              );
            }
            try {
              await terminal.reattachLostSession(sessionId);
              return { kind: "reattached" };
            } catch (reason) {
              const status = await getPtySessionWindowStatus(sessionId).catch(
                () => null,
              );
              if (status?.state === "ended") {
                const pending = takePendingWorkspaceContentWindow(
                  pendingDetachedRef.current,
                  workspacePtyKey(slot.instanceId),
                );
                pending?.reject(
                  new Error(tRef.current("pty.detachedStartFailed")),
                );
                removeSlot(slot.instanceId);
                return { kind: "ended" };
              }
              if (status?.state === "ownedByAnotherWindow") {
                return { kind: "foreign-owner" };
              }
              console.warn(
                `Failed to reclaim PTY session ${sessionId}; will retry:`,
                reason,
              );
              throw reason;
            }
          },
          {
            maxAttempts: PTY_OWNER_LOST_MAX_ATTEMPTS,
            delayMs: ptyOwnerLostRetryDelay,
            signal,
            onExhausted: (lastError, attempts) => {
              console.error(
                `PTY owner-lost recovery gave up for session ${sessionId} after ${attempts} attempts`,
                lastError,
              );
              toast.error(tRef.current("pty.ownerLostRecoveryFailed"));
            },
          },
        );
        if (
          signal.aborted ||
          outcome.status !== "succeeded" ||
          outcome.value.kind !== "reattached"
        ) {
          return;
        }

        const slot = slotsRef.current.find(
          (candidate) => candidate.sessionId === sessionId,
        );
        if (!slot) return;
        const content = { kind: "pty", slotId: slot.instanceId } as const;
        const currentTree = treeRef.current;
        const existingPane = listWorkspacePanes(currentTree).find((pane) =>
          hasWorkspaceContent(pane, content),
        );
        const targetPane =
          existingPane ??
          findWorkspacePane(currentTree, focusedPaneIdRef.current) ??
          listWorkspacePanes(currentTree)[0];
        if (!targetPane) return;
        const pending = takePendingWorkspaceContentWindow(
          pendingDetachedRef.current,
          workspacePtyKey(slot.instanceId),
        );
        pending?.reject(new Error(tRef.current("pty.detachedStartTimedOut")));
        const detached = detachedByInstanceRef.current.get(
          workspacePtyKey(slot.instanceId),
        );
        detachedByInstanceRef.current.delete(workspacePtyKey(slot.instanceId));
        if (detached) void detached.destroy().catch(() => undefined);
        contentCoordinatorRef.current.ownerEnded(content);
        contentCoordinatorRef.current.ensureAttached(content, {
          kind: "pane",
          windowLabel: "main",
          paneId: targetPane.id,
        });
        const nextTree = reduceWorkspaceTree(
          currentTree,
          existingPane
            ? { type: "activate", ref: content, paneId: existingPane.id }
            : { type: "return", ref: content, toPaneId: targetPane.id },
        );
        commitTree(nextTree);
        setFocusedPane(existingPane?.id ?? targetPane.id);
        useAppStore.getState().openDirectory(slot.directoryId);
      } finally {
        ownerLostRecoveriesRef.current.delete(sessionId);
      }
    },
    [commitTree, removeSlot, setFocusedPane, terminalRefs],
  );

  const handlePtyReturnRequest = useCallback(
    async (payload: PtyReturnRequestEvent) => {
      const fail = (message: string) =>
        void emitWorkspaceContentWindowEvent(
          payload.windowLabel,
          "pty-return-failed",
          {
            instanceId: payload.instanceId,
            token: payload.token,
            message,
          },
        ).catch(() => undefined);
      const returningContent = {
        kind: "pty",
        slotId: payload.instanceId,
      } as const;
      const key = workspacePtyKey(payload.instanceId);
      // 返回完成之后到达的重复请求：静默忽略，不得走 reconcileDetached。
      if (contentCoordinatorRef.current.isReturnCompleted(payload.token)) {
        return;
      }
      const currentOwnership =
        contentCoordinatorRef.current.get(returningContent);
      const knownWindowLabel =
        ownerWindowOf(currentOwnership)?.windowLabel ?? null;
      if (knownWindowLabel && knownWindowLabel !== payload.windowLabel) {
        fail(tRef.current("pty.detachedSessionMissing"));
        return;
      }
      if (
        !knownWindowLabel &&
        windowKindOf(payload.windowLabel) !== "terminal"
      ) {
        fail(tRef.current("pty.detachedSessionMissing"));
        return;
      }
      let detachedWindow = detachedByInstanceRef.current.get(key);
      if (!detachedWindow || !knownWindowLabel) {
        try {
          const [windowStatus, detachedWindow] = await Promise.all([
            getPtySessionWindowStatus(payload.sessionId),
            WebviewWindow.getByLabel(payload.windowLabel),
          ]);
          if (
            windowStatus.state !== "ownedByAnotherWindow" ||
            !detachedWindow
          ) {
            fail(tRef.current("pty.detachedStateChanged"));
            return;
          }
          detachedByInstanceRef.current.set(key, detachedWindow);
        } catch (reason) {
          fail(
            tRef.current("pty.returnFailed", {
              error: formatAppError(reason, tRef.current),
            }),
          );
          return;
        }
      }
      detachedWindow ??= detachedByInstanceRef.current.get(key);
      if (!detachedWindow) {
        fail(tRef.current("pty.detachedStateChanged"));
        return;
      }
      if (
        currentOwnership?.phase === "returning" &&
        currentOwnership.transferId === payload.token
      ) {
        return;
      }
      if (currentOwnership?.phase !== "detached") {
        const sourcePane =
          listWorkspacePanes(treeRef.current).find((pane) =>
            hasWorkspaceContent(pane, returningContent),
          ) ??
          findWorkspacePane(treeRef.current, focusedPaneIdRef.current) ??
          listWorkspacePanes(treeRef.current)[0];
        if (sourcePane) {
          contentCoordinatorRef.current.reconcileDetached(
            returningContent,
            {
              kind: "pane",
              windowLabel: "main",
              paneId: sourcePane.id,
            },
            { kind: "window", windowLabel: payload.windowLabel },
            payload.token,
          );
        }
      }
      const returnTargetPaneId = resolveWorkspaceReturnPaneId(treeRef.current, {
        requestedPaneId: payload.targetPaneId,
        lastPaneId: (() => {
          const latest = contentCoordinatorRef.current.get(returningContent);
          return latest?.phase === "detached" ? latest.lastPaneId : null;
        })(),
        focusedPaneId: focusedPaneIdRef.current,
      });
      if (!returnTargetPaneId) {
        fail(tRef.current("pty.workspaceRestoring"));
        return;
      }
      const returning = contentCoordinatorRef.current.beginReturn(
        returningContent,
        payload.token,
        "main",
        returnTargetPaneId,
      );
      if (returning?.outcome !== "changed") {
        fail(tRef.current("pty.detachedStateChanged"));
        return;
      }
      const failPendingReturn = (message: string) => {
        contentCoordinatorRef.current.failHandoff(
          returningContent,
          "returnFailed",
          payload.token,
        );
        fail(message);
      };
      let returnDriverContext: WorkspaceContentHandoffHookContext<"pty"> | null =
        null;
      let returnDriverPayload:
        | WorkspaceContentHandoffPayloadByKind["pty"]
        | undefined;
      try {
        ptyReturnWaitAbortRef.current?.abort();
        const waitAbortController = new AbortController();
        ptyReturnWaitAbortRef.current = waitAbortController;
        const deadline = Date.now() + 10_000;
        let slot = slotsRef.current.find(
          (candidate) => candidate.instanceId === payload.instanceId,
        );
        let terminal = terminalRefs.current.get(payload.instanceId);
        while (
          (!slot || !terminal || hydrationStatusRef.current !== "ready") &&
          Date.now() < deadline &&
          !waitAbortController.signal.aborted
        ) {
          await abortableDelay(50, waitAbortController.signal);
          if (waitAbortController.signal.aborted) return;
          slot = slotsRef.current.find(
            (candidate) => candidate.instanceId === payload.instanceId,
          );
          terminal = terminalRefs.current.get(payload.instanceId);
        }
        if (ptyReturnWaitAbortRef.current === waitAbortController) {
          ptyReturnWaitAbortRef.current = null;
        }
        if (waitAbortController.signal.aborted) return;
        if (!slot || !terminal || hydrationStatusRef.current !== "ready") {
          failPendingReturn(tRef.current("pty.workspaceRestoring"));
          return;
        }
        if (slot.sessionId !== payload.sessionId) {
          failPendingReturn(tRef.current("pty.detachedSessionMissing"));
          return;
        }
        const currentTree = treeRef.current;
        const targetPane =
          (payload.targetPaneId &&
            findWorkspacePane(currentTree, payload.targetPaneId)) ||
          findWorkspacePane(currentTree, focusedPaneIdRef.current) ||
          listWorkspacePanes(currentTree)[0];
        if (!targetPane) {
          failPendingReturn(tRef.current("pty.workspaceRestoring"));
          return;
        }
        returnDriverContext = {
          content: returningContent,
          source: { kind: "window", windowLabel: payload.windowLabel },
          target: { kind: "pane", windowLabel: "main", paneId: targetPane.id },
          transferId: payload.token,
          capabilities: {
            prepare: async () => ({ handoff: { token: payload.token } }),
            attach: async (handoffPayload) => {
              await terminal.attachHandoff(
                payload.sessionId,
                handoffPayload.handoff.token,
              );
            },
            rollback: async (handoffPayload) => {
              if (handoffPayload) {
                await terminal.cancelHandoff(handoffPayload.handoff.token);
              }
            },
          },
        };
        returnDriverPayload = { handoff: { token: payload.token } };
        await attachWorkspaceContentHandoff(
          returnDriverContext,
          returnDriverPayload,
        );
        const activeReturn =
          contentCoordinatorRef.current.get(returningContent);
        if (
          activeReturn?.phase !== "returning" ||
          activeReturn.transferId !== payload.token
        ) {
          throw new Error(tRef.current("pty.detachedStateChanged"));
        }
        // 在最新树上计算；从这里到 commitTree 之间不得出现 await。
        // 目标 pane 以 beginReturn 时协调器记录的为准（returnReady 把 owner 设为它）。
        const recordedPaneId = activeReturn.target.paneId;
        const plan = planWorkspaceReturn(treeRef.current, {
          ref: returningContent,
          requestedPaneId: recordedPaneId,
          focusedPaneId: focusedPaneIdRef.current,
          whenAlreadyInTree: "activate",
        });
        if (!plan || plan.focusPaneId !== recordedPaneId) {
          throw new Error(tRef.current("pty.workspaceRestoring"));
        }
        // 先确认归属变更成立，再改树；被拒绝时抛出，由 catch 回滚终端交接并通知子窗口。
        const ownership = contentCoordinatorRef.current.completeHandoff(
          returningContent,
          "returnReady",
          payload.token,
        );
        if (ownership?.outcome !== "changed") {
          throw new Error(tRef.current("pty.detachedStateChanged"));
        }
        commitTree(plan.nextTree);
        setFocusedPane(plan.focusPaneId);
        detachedByInstanceRef.current.delete(
          workspacePtyKey(payload.instanceId),
        );
        useAppStore.getState().openDirectory(slot.directoryId);
        try {
          await detachedWindow.destroy();
        } catch (reason) {
          console.warn("Failed to destroy returned PTY window", reason);
          await emitWorkspaceContentWindowEvent(
            payload.windowLabel,
            "pty-return-complete",
            {
              instanceId: payload.instanceId,
              token: payload.token,
            },
          ).catch(() => undefined);
        }
      } catch (reason) {
        if (returnDriverContext) {
          void rollbackWorkspaceContentHandoff(
            returnDriverContext,
            returnDriverPayload,
            reason,
          ).catch(() => undefined);
        }
        failPendingReturn(formatAppError(reason, tRef.current));
      }
    },
    [commitTree, setFocusedPane, terminalRefs],
  );

  useEffect(() => {
    const controller = new AbortController();
    let unlisten: () => void = () => undefined;
    void setupWorkspaceContentListeners({
      registrations: [
        {
          name: "pty-detached-ready",
          register: () =>
            listenWorkspaceContentWindowEvent("pty-detached-ready", (event) =>
              handleDetachedReady(event.payload),
            ),
        },
        {
          name: "pty-detached-failed",
          register: () =>
            listenWorkspaceContentWindowEvent("pty-detached-failed", (event) =>
              handleDetachedFailed(event.payload),
            ),
        },
        {
          name: "pty-session-owner-lost",
          register: () =>
            listen<PtySessionOwnerLostEvent>(
              "pty-session-owner-lost",
              (event) => {
                void handlePtySessionOwnerLost(event.payload);
              },
            ),
        },
        {
          name: "pty-return-requested",
          register: () =>
            listenWorkspaceContentWindowEvent(
              "pty-return-requested",
              (event) => {
                void handlePtyReturnRequest(event.payload);
              },
            ),
        },
        {
          name: "pty-detached-exited",
          register: () =>
            listenWorkspaceContentWindowEvent(
              "pty-detached-exited",
              (event) => {
                const pending = pendingDetachedRef.current.get(
                  workspacePtyKey(event.payload.instanceId),
                );
                if (pending && matchesDetachedWindow(pending, event.payload)) {
                  void rollbackWorkspaceContentHandoff(
                    pending.handoffContext,
                    pending.handoffPayload,
                    new Error(tRef.current("pty.detachedExitedBeforeReady")),
                  ).catch(() => undefined);
                  contentCoordinatorRef.current.failHandoff(
                    { kind: "pty", slotId: event.payload.instanceId },
                    "detachCancelled",
                    pending.token,
                  );
                  takePendingWorkspaceContentWindow(
                    pendingDetachedRef.current,
                    workspacePtyKey(event.payload.instanceId),
                    pending.windowLabel,
                  );
                  pending.reject(
                    new Error(tRef.current("pty.detachedExitedBeforeReady")),
                  );
                  void pending.window.destroy().catch(() => undefined);
                  removeSlot(event.payload.instanceId);
                  return;
                }
                const content = {
                  kind: "pty",
                  slotId: event.payload.instanceId,
                } as const;
                const owner = contentCoordinatorRef.current.get(content);
                const slot = slotsRef.current.find(
                  (candidate) =>
                    candidate.instanceId === event.payload.instanceId,
                );
                if (
                  slot?.sessionId === event.payload.sessionId &&
                  (((owner?.phase === "detached" ||
                    owner?.phase === "closing") &&
                    owner.owner.kind === "window" &&
                    owner.owner.windowLabel === event.payload.windowLabel) ||
                    (owner?.phase === "returning" &&
                      owner.source.windowLabel === event.payload.windowLabel))
                ) {
                  removeSlot(event.payload.instanceId);
                }
              },
            ),
        },
      ],
      signal: controller.signal,
      retryDelaysMs: listenerRetryDelaysRef.current,
      onFailed: (failed) => reportListenerSetupFailure("PTY window", failed),
    }).then((cleanup) => {
      unlisten = cleanup;
    });
    return () => {
      controller.abort();
      unlisten();
    };
  }, [
    handleDetachedFailed,
    handleDetachedReady,
    handlePtyReturnRequest,
    handlePtySessionOwnerLost,
    removeSlot,
    reportListenerSetupFailure,
  ]);

  // 独立 effect：依赖只有稳定回调（不含 t），语言切换不会注销重建该监听。
  useEffect(() => {
    const controller = new AbortController();
    let unlisten: () => void = () => undefined;
    void setupWorkspaceContentListeners({
      registrations: [
        {
          name: "workspace-content-window-lost",
          register: () =>
            listen<WorkspaceContentWindowLostEvent>(
              "workspace-content-window-lost",
              (event) => {
                handleWorkspaceContentWindowLost(event.payload);
              },
            ),
        },
      ],
      signal: controller.signal,
      retryDelaysMs: listenerRetryDelaysRef.current,
      onFailed: (failed) =>
        reportListenerSetupFailure("content window lost", failed),
    }).then((cleanup) => {
      unlisten = cleanup;
    });
    return () => {
      controller.abort();
      unlisten();
    };
  }, [handleWorkspaceContentWindowLost, reportListenerSetupFailure]);

  useEffect(() => {
    const controller = new AbortController();
    let unlisten: () => void = () => undefined;
    const setup = async () => {
      const cleanup = await setupWorkspaceContentListeners({
        registrations: [
          {
            name: "workspace-file-window-ready",
            register: () =>
              listenWorkspaceContentWindowEvent(
                "workspace-file-window-ready",
                async (event) => {
                  const pending = pendingDetachedFilesRef.current.get(
                    workspaceFileKey(event.payload.documentId),
                  );
                  if (
                    !pending ||
                    !matchesWorkspaceFileWindow(pending, event.payload)
                  ) {
                    return;
                  }
                  if (!advancePendingWindowStage(pending, "windowReady")) {
                    console.warn(
                      `Ignoring duplicate or late workspace-file-window-ready for ${pending.documentId} (stage ${pending.stage}).`,
                    );
                    return;
                  }
                  const content = {
                    kind: "file",
                    documentId: pending.documentId,
                  } as const;
                  const driverContext: WorkspaceContentHandoffHookContext<"file"> =
                    {
                      content,
                      source: {
                        kind: "pane",
                        windowLabel: "main",
                        paneId:
                          pending.sourcePaneId ??
                          listWorkspacePanes(treeRef.current)[0]?.id ??
                          "unknown-pane",
                      },
                      target: {
                        kind: "window",
                        windowLabel: pending.windowLabel,
                      },
                      transferId: pending.token,
                      capabilities: {
                        prepare: async () => {
                          const document = fileDocumentsRef.current.find(
                            (candidate) => candidate.id === pending.documentId,
                          );
                          const buffer =
                            fileBuffersRef.current[pending.documentId];
                          if (!document || !buffer) {
                            throw new Error(
                              tRef.current("workspaceFiles.loadingFile"),
                            );
                          }
                          return { document, buffer };
                        },
                        attach: async () => undefined,
                        rollback: async () => undefined,
                      },
                    };
                  let prepared: Awaited<
                    ReturnType<typeof prepareWorkspaceContentHandoff<"file">>
                  >;
                  try {
                    prepared =
                      await prepareWorkspaceContentHandoff(driverContext);
                    pending.handoffContext = driverContext;
                    pending.handoffPayload = prepared.payload;
                  } catch (reason) {
                    void rollbackWorkspaceContentHandoff(
                      driverContext,
                      undefined,
                      reason,
                    ).catch(() => undefined);
                    contentCoordinatorRef.current.failHandoff(
                      content,
                      "detachFailed",
                      pending.token,
                    );
                    takePendingWorkspaceContentWindow(
                      pendingDetachedFilesRef.current,
                      workspaceFileKey(pending.documentId),
                      pending.windowLabel,
                    );
                    pending.reject(
                      new Error(formatAppError(reason, tRef.current)),
                    );
                    void pending.window.destroy().catch(() => undefined);
                    return;
                  }
                  if (!advancePendingWindowStage(pending, "initSent")) return;
                  await emitWorkspaceContentWindowEvent(
                    pending.windowLabel,
                    "workspace-file-window-init",
                    {
                      documentId: pending.documentId,
                      token: pending.token,
                      windowLabel: pending.windowLabel,
                      fileDocument: prepared.payload.document,
                      fileBuffer: prepared.payload.buffer,
                    },
                  );
                },
              ),
          },
          {
            name: "workspace-file-window-attached",
            register: () =>
              listenWorkspaceContentWindowEvent(
                "workspace-file-window-attached",
                (event) => {
                  const pending = pendingDetachedFilesRef.current.get(
                    workspaceFileKey(event.payload.documentId),
                  );
                  if (
                    !pending ||
                    !matchesWorkspaceFileWindow(pending, event.payload)
                  ) {
                    return;
                  }
                  // 只有 init 已发出（阶段为 initSent）的 pending 才接受 attached。
                  if (!advancePendingWindowStage(pending, "attachedAck")) {
                    return;
                  }
                  const content = {
                    kind: "file",
                    documentId: pending.documentId,
                  } as const;
                  const ownership =
                    contentCoordinatorRef.current.completeHandoff(
                      content,
                      "detachReady",
                      pending.token,
                    );
                  if (ownership?.outcome !== "changed") {
                    if (pending.handoffContext) {
                      void rollbackWorkspaceContentHandoff(
                        pending.handoffContext,
                        pending.handoffPayload,
                        new Error(tRef.current("pty.detachedStateChanged")),
                      ).catch(() => undefined);
                    }
                    takePendingWorkspaceContentWindow(
                      pendingDetachedFilesRef.current,
                      workspaceFileKey(pending.documentId),
                      pending.windowLabel,
                    );
                    pending.reject(
                      new Error(tRef.current("pty.detachedStateChanged")),
                    );
                    void pending.window.destroy().catch(() => undefined);
                    return;
                  }
                  promotePendingWorkspaceContentWindow({
                    pending: pendingDetachedFilesRef.current,
                    detached: detachedFilesRef.current,
                    key: workspaceFileKey(pending.documentId),
                    expectedWindowLabel: pending.windowLabel,
                    toDetached: (record) => record.window,
                  });
                  commitTree(
                    reduceWorkspaceTree(treeRef.current, {
                      type: "detach",
                      ref: content,
                    }),
                  );
                  pending.resolve();
                },
              ),
          },
          {
            name: "workspace-file-window-attach-failed",
            register: () =>
              listenWorkspaceContentWindowEvent(
                "workspace-file-window-attach-failed",
                (event) => {
                  const pending = pendingDetachedFilesRef.current.get(
                    workspaceFileKey(event.payload.documentId),
                  );
                  if (
                    !pending ||
                    !matchesWorkspaceFileWindow(pending, event.payload)
                  ) {
                    return;
                  }
                  if (pending.handoffContext) {
                    void rollbackWorkspaceContentHandoff(
                      pending.handoffContext,
                      pending.handoffPayload,
                      new Error(
                        event.payload.message ??
                          tRef.current("pty.detachedStartFailed"),
                      ),
                    ).catch(() => undefined);
                  }
                  contentCoordinatorRef.current.failHandoff(
                    { kind: "file", documentId: pending.documentId },
                    "detachFailed",
                    pending.token,
                  );
                  takePendingWorkspaceContentWindow(
                    pendingDetachedFilesRef.current,
                    workspaceFileKey(pending.documentId),
                    pending.windowLabel,
                  );
                  pending.reject(
                    new Error(
                      event.payload.message ??
                        tRef.current("pty.detachedStartFailed"),
                    ),
                  );
                  void pending.window.destroy().catch(() => undefined);
                },
              ),
          },
          {
            name: "workspace-file-window-buffer-changed",
            register: () =>
              listenWorkspaceContentWindowEvent(
                "workspace-file-window-buffer-changed",
                (event) => {
                  const content = {
                    kind: "file",
                    documentId: event.payload.documentId,
                  } as const;
                  const owner = contentCoordinatorRef.current.get(content);
                  if (
                    !event.payload.fileBuffer ||
                    owner?.phase !== "detached" ||
                    owner.owner.kind !== "window" ||
                    owner.owner.windowLabel !== event.payload.windowLabel ||
                    owner.windowToken !== event.payload.token
                  ) {
                    return;
                  }
                  const currentBuffer =
                    fileBuffersRef.current[content.documentId];
                  if (
                    !isWorkspaceFileBufferNewer(
                      event.payload.fileBuffer,
                      currentBuffer,
                    )
                  ) {
                    return;
                  }
                  const next = {
                    ...fileBuffersRef.current,
                    [content.documentId]: event.payload.fileBuffer,
                  };
                  fileBuffersRef.current = next;
                  setFileBuffers(next);
                },
              ),
          },
          {
            name: "workspace-file-window-return-requested",
            register: () =>
              listenWorkspaceContentWindowEvent(
                "workspace-file-window-return-requested",
                async (event) => {
                  const knownDocument = fileDocumentsRef.current.find(
                    (document) => document.id === event.payload.documentId,
                  );
                  const incomingDocument = event.payload.fileDocument;
                  const incomingBuffer = event.payload.fileBuffer;
                  if (
                    !knownDocument ||
                    !incomingBuffer ||
                    !workspaceFileDocumentIdentityMatches(
                      knownDocument,
                      incomingDocument,
                    )
                  ) {
                    await emitWorkspaceContentWindowEvent(
                      event.payload.windowLabel,
                      "workspace-file-window-return-failed",
                      {
                        documentId: event.payload.documentId,
                        token: event.payload.token,
                        message: tRef.current("pty.returnFailed", {
                          error: tRef.current("pty.workspaceRestoring"),
                        }),
                      },
                    ).catch(() => undefined);
                    return;
                  }
                  // 返回完成之后到达的重复请求：静默忽略，不得走 reconcileDetached。
                  if (
                    contentCoordinatorRef.current.isReturnCompleted(
                      event.payload.token,
                    )
                  ) {
                    return;
                  }
                  const content = {
                    kind: "file",
                    documentId: event.payload.documentId,
                  } as const;
                  const key = workspaceFileKey(content.documentId);
                  let managedWindow = detachedFilesRef.current.get(key);
                  if (!managedWindow) {
                    try {
                      managedWindow =
                        (await WebviewWindow.getByLabel(
                          event.payload.windowLabel,
                        )) ?? undefined;
                    } catch {
                      managedWindow = undefined;
                    }
                  }
                  if (
                    !managedWindow ||
                    windowKindOf(event.payload.windowLabel) !==
                      "workspaceContent"
                  ) {
                    await emitWorkspaceContentWindowEvent(
                      event.payload.windowLabel,
                      "workspace-file-window-return-failed",
                      {
                        documentId: event.payload.documentId,
                        token: event.payload.token,
                        message: tRef.current("pty.returnFailed", {
                          error: tRef.current("pty.workspaceRestoring"),
                        }),
                      },
                    ).catch(() => undefined);
                    return;
                  }
                  let currentOwnership =
                    contentCoordinatorRef.current.get(content);
                  if (
                    currentOwnership?.phase === "returning" &&
                    currentOwnership.transferId === event.payload.token
                  ) {
                    return;
                  }
                  if (currentOwnership?.phase === "detached") {
                    if (
                      currentOwnership.owner.kind !== "window" ||
                      currentOwnership.owner.windowLabel !==
                        event.payload.windowLabel ||
                      currentOwnership.windowToken !== event.payload.token
                    ) {
                      await emitWorkspaceContentWindowEvent(
                        event.payload.windowLabel,
                        "workspace-file-window-return-failed",
                        {
                          documentId: event.payload.documentId,
                          token: event.payload.token,
                          message: tRef.current("pty.returnFailed", {
                            error: tRef.current("pty.detachedStateChanged"),
                          }),
                        },
                      ).catch(() => undefined);
                      return;
                    }
                  } else if (
                    !currentOwnership ||
                    currentOwnership.phase === "attached"
                  ) {
                    const sourcePane =
                      listWorkspacePanes(treeRef.current).find((pane) =>
                        hasWorkspaceContent(pane, content),
                      ) ??
                      findWorkspacePane(
                        treeRef.current,
                        focusedPaneIdRef.current,
                      ) ??
                      listWorkspacePanes(treeRef.current)[0];
                    if (sourcePane) {
                      contentCoordinatorRef.current.reconcileDetached(
                        content,
                        {
                          kind: "pane",
                          windowLabel: "main",
                          paneId: sourcePane.id,
                        },
                        {
                          kind: "window",
                          windowLabel: event.payload.windowLabel,
                        },
                        event.payload.token,
                      );
                      currentOwnership =
                        contentCoordinatorRef.current.get(content);
                    }
                  }
                  if (
                    currentOwnership?.phase !== "detached" ||
                    currentOwnership.owner.kind !== "window" ||
                    currentOwnership.owner.windowLabel !==
                      event.payload.windowLabel ||
                    currentOwnership.windowToken !== event.payload.token
                  ) {
                    await emitWorkspaceContentWindowEvent(
                      event.payload.windowLabel,
                      "workspace-file-window-return-failed",
                      {
                        documentId: event.payload.documentId,
                        token: event.payload.token,
                        message: tRef.current("pty.returnFailed", {
                          error: tRef.current("pty.detachedStateChanged"),
                        }),
                      },
                    ).catch(() => undefined);
                    return;
                  }
                  detachedFilesRef.current.set(key, managedWindow);
                  const returnTargetPaneId = resolveWorkspaceReturnPaneId(
                    treeRef.current,
                    {
                      requestedPaneId: event.payload.targetPaneId,
                      lastPaneId: (() => {
                        const latest =
                          contentCoordinatorRef.current.get(content);
                        return latest?.phase === "detached"
                          ? latest.lastPaneId
                          : null;
                      })(),
                      focusedPaneId: focusedPaneIdRef.current,
                    },
                  );
                  if (!returnTargetPaneId) {
                    await emitWorkspaceContentWindowEvent(
                      event.payload.windowLabel,
                      "workspace-file-window-return-failed",
                      {
                        documentId: event.payload.documentId,
                        token: event.payload.token,
                        message: tRef.current("pty.returnFailed", {
                          error: tRef.current("pty.workspaceRestoring"),
                        }),
                      },
                    ).catch(() => undefined);
                    return;
                  }
                  const returning = contentCoordinatorRef.current.beginReturn(
                    content,
                    event.payload.token,
                    "main",
                    returnTargetPaneId,
                  );
                  if (returning?.outcome !== "changed") {
                    await emitWorkspaceContentWindowEvent(
                      event.payload.windowLabel,
                      "workspace-file-window-return-failed",
                      {
                        documentId: event.payload.documentId,
                        token: event.payload.token,
                        message: tRef.current("pty.returnFailed", {
                          error: tRef.current("pty.detachedStateChanged"),
                        }),
                      },
                    ).catch(() => undefined);
                    return;
                  }
                  let fileReturnDriverContext: WorkspaceContentHandoffHookContext<"file"> | null =
                    null;
                  let fileReturnDriverPayload:
                    | WorkspaceContentHandoffPayloadByKind["file"]
                    | undefined;
                  try {
                    const document = knownDocument;
                    const currentBuffer = fileBuffersRef.current[document.id];
                    const returnedBuffer =
                      currentBuffer &&
                      isWorkspaceFileBufferNewer(currentBuffer, incomingBuffer)
                        ? currentBuffer
                        : incomingBuffer;
                    let targetPane = event.payload.targetPaneId
                      ? findWorkspacePane(
                          treeRef.current,
                          event.payload.targetPaneId,
                        )
                      : null;
                    targetPane ??=
                      listWorkspacePanes(treeRef.current).find((candidate) =>
                        hasWorkspaceContent(candidate, {
                          kind: "file",
                          documentId: document.id,
                        }),
                      ) ?? null;
                    targetPane ??= findWorkspacePane(
                      treeRef.current,
                      focusedPaneIdRef.current,
                    );
                    if (!targetPane)
                      throw new Error(tRef.current("pty.workspaceRestoring"));
                    fileReturnDriverContext = {
                      content,
                      source: {
                        kind: "window",
                        windowLabel: event.payload.windowLabel,
                      },
                      target: {
                        kind: "pane",
                        windowLabel: "main",
                        paneId: targetPane.id,
                      },
                      transferId: event.payload.token,
                      capabilities: {
                        prepare: async () => ({
                          document,
                          buffer: returnedBuffer,
                        }),
                        attach: async (handoffPayload) => {
                          const nextBuffers = {
                            ...fileBuffersRef.current,
                            [document.id]: handoffPayload.buffer,
                          };
                          fileBuffersRef.current = nextBuffers;
                          setFileBuffers(nextBuffers);
                        },
                        rollback: async () => undefined,
                      },
                    };
                    fileReturnDriverPayload = {
                      document,
                      buffer: returnedBuffer,
                    };
                    await attachWorkspaceContentHandoff(
                      fileReturnDriverContext,
                      fileReturnDriverPayload,
                    );
                    const activeReturn =
                      contentCoordinatorRef.current.get(content);
                    if (
                      activeReturn?.phase !== "returning" ||
                      activeReturn.transferId !== event.payload.token
                    ) {
                      throw new Error(tRef.current("pty.detachedStateChanged"));
                    }
                    // 在最新树上计算；从这里到 commitTree 之间不得出现 await。
                    // 目标 pane 以 beginReturn 时协调器记录的为准（returnReady 把 owner 设为它）。
                    const recordedPaneId = activeReturn.target.paneId;
                    const plan = planWorkspaceReturn(treeRef.current, {
                      ref: content,
                      requestedPaneId: recordedPaneId,
                      focusedPaneId: focusedPaneIdRef.current,
                      whenAlreadyInTree: "relocate",
                    });
                    if (!plan || plan.focusPaneId !== recordedPaneId) {
                      throw new Error(tRef.current("pty.workspaceRestoring"));
                    }
                    // 先确认归属变更成立，再改树；被拒绝时树保持原样，子窗口仍可重试。
                    const ownership =
                      contentCoordinatorRef.current.completeHandoff(
                        { kind: "file", documentId: document.id },
                        "returnReady",
                        event.payload.token,
                      );
                    if (ownership?.outcome !== "changed") {
                      contentCoordinatorRef.current.failHandoff(
                        { kind: "file", documentId: document.id },
                        "returnFailed",
                        event.payload.token,
                      );
                      await emitWorkspaceContentWindowEvent(
                        event.payload.windowLabel,
                        "workspace-file-window-return-failed",
                        {
                          documentId: document.id,
                          token: event.payload.token,
                          message: tRef.current("pty.returnFailed", {
                            error: tRef.current("pty.detachedStateChanged"),
                          }),
                        },
                      ).catch(() => undefined);
                      return;
                    }
                    commitTree(plan.nextTree);
                    setFocusedPane(plan.focusPaneId);
                    detachedFilesRef.current.delete(
                      workspaceFileKey(document.id),
                    );
                    await revokeContentWindowFile(
                      event.payload.windowLabel,
                    ).catch((reason) =>
                      console.warn(
                        "Unable to revoke returned file window grant",
                        reason,
                      ),
                    );
                    await emitWorkspaceContentWindowEvent(
                      event.payload.windowLabel,
                      "workspace-file-window-return-complete",
                      {
                        documentId: document.id,
                        token: event.payload.token,
                      },
                    ).catch(() =>
                      managedWindow.destroy().catch(() => undefined),
                    );
                  } catch (reason) {
                    if (fileReturnDriverContext) {
                      await rollbackWorkspaceContentHandoff(
                        fileReturnDriverContext,
                        fileReturnDriverPayload,
                        reason,
                      ).catch(() => undefined);
                    }
                    contentCoordinatorRef.current.failHandoff(
                      { kind: "file", documentId: event.payload.documentId },
                      "returnFailed",
                      event.payload.token,
                    );
                    await emitWorkspaceContentWindowEvent(
                      event.payload.windowLabel,
                      "workspace-file-window-return-failed",
                      {
                        documentId: event.payload.documentId,
                        token: event.payload.token,
                        message: tRef.current("pty.returnFailed", {
                          error: formatAppError(reason, tRef.current),
                        }),
                      },
                    ).catch(() => undefined);
                  }
                },
              ),
          },
        ],
        signal: controller.signal,
        retryDelaysMs: listenerRetryDelaysRef.current,
        onFailed: (failed) => reportListenerSetupFailure("file window", failed),
      });
      unlisten = cleanup;
    };
    void setup().catch((reason) =>
      console.error("File window listener setup failed", reason),
    );
    return () => {
      controller.abort();
      unlisten();
    };
  }, [commitTree, setFocusedPane, reportListenerSetupFailure]);

  const closeEmptyPane = useCallback(
    (paneId: string) => {
      const pane = findWorkspacePane(treeRef.current, paneId);
      if (!pane || pane.contents.length > 0) {
        return;
      }
      const next = removeEmptyWorkspacePane(treeRef.current, paneId);
      commitTree(next);
      // Closing a pane changes the split topology. Remount the complete tree
      // so every Allotment recalculates from the surviving tree dimensions,
      // rather than retaining any cached sizes from the previous topology.
      setWorkspaceTreeRevision((revision) => revision + 1);
      if (!findWorkspacePane(next, focusedPaneIdRef.current)) {
        const fallbackPaneId = listWorkspacePanes(next)[0].id;
        setFocusedPane(fallbackPaneId);
        const activeContent = findWorkspacePane(
          next,
          fallbackPaneId,
        )?.activeContent;
        if (activeContent) syncProjectContext(activeContent);
      }
    },
    [commitTree, setFocusedPane, syncProjectContext],
  );

  const updateSplitRatio = useCallback(
    (splitId: string, sizes: number[], phase: SplitResizePhase) => {
      const total = sizes.reduce((sum, size) => sum + size, 0);
      if (sizes.length !== 2 || total <= 0 || !Number.isFinite(total)) return;

      const nextTree = setWorkspaceSplitRatio(
        treeRef.current,
        splitId,
        sizes[0] / total,
      );
      treeRef.current = nextTree;

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
      upsertPtySession(session);
      const nextSlots = slotsRef.current.map((slot) =>
        slot.instanceId === instanceId
          ? { ...slot, sessionId: session.sessionId }
          : slot,
      );
      slotsRef.current = nextSlots;
      setSlots(nextSlots);
    },
    [removeSlot, upsertPtySession],
  );

  const getCurrentPresetLayout = useCallback(() => {
    let presetTree = treeRef.current;
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
    const currentFocusedPaneId = focusedPaneIdRef.current;
    return createWorkspaceLayoutDocument({
      tree: presetTree,
      focusedPaneId: presetPanes.some(
        (pane) => pane.id === currentFocusedPaneId,
      )
        ? currentFocusedPaneId
        : presetPanes[0].id,
      slots: slotsRef.current
        .filter((slot) => paneSlotIds.has(slot.instanceId))
        .map((slot) => toWorkspaceLayoutSlot(slot, directories ?? [])),
      documents: fileDocumentsRef.current.filter((document) =>
        paneFileIds.has(document.id),
      ),
      detachedContents: [],
    });
  }, [directories]);

  const collectExitImpacts = useCallback(async (ptyCount: number) => {
    const managedWindows = new Map<
      string,
      { documentId: string; token: string; windowLabel: string }
    >();
    for (const content of contentCoordinatorRef.current.listWindowOwned()) {
      if (content.kind !== "file") continue;
      const state = contentCoordinatorRef.current.get(content);
      if (!state) continue;
      const owner = ownerWindowOf(state);
      if (owner && owner.windowToken) {
        managedWindows.set(content.documentId, {
          documentId: content.documentId,
          token: owner.windowToken,
          windowLabel: owner.windowLabel,
        });
      }
    }
    for (const pending of pendingDetachedFilesRef.current.values()) {
      managedWindows.set(pending.documentId, {
        documentId: pending.documentId,
        token: pending.token,
        windowLabel: pending.windowLabel,
      });
    }

    const flushResults = await Promise.all(
      [...managedWindows.values()].map(async (managed) => ({
        managed,
        response: await requestWorkspaceFileBufferFlush({
          target: {
            documentId: managed.documentId,
            token: managed.token,
            windowLabel: managed.windowLabel,
          },
          listen: (handler) =>
            listenWorkspaceContentWindowEvent(
              "workspace-file-window-flush-complete",
              ({ payload }) => handler(payload),
            ),
          emit: (requestId) =>
            emitWorkspaceContentWindowEvent(
              managed.windowLabel,
              "workspace-file-window-flush-requested",
              {
                documentId: managed.documentId,
                token: managed.token,
                windowLabel: managed.windowLabel,
                requestId,
              },
            ),
        }),
      })),
    );
    const uncertainDocumentIds: string[] = [];
    let nextBuffers = fileBuffersRef.current;
    for (const { managed, response } of flushResults) {
      const currentDocument = fileDocumentsRef.current.find(
        (document) => document.id === managed.documentId,
      );
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
        if (nextBuffers === fileBuffersRef.current) {
          nextBuffers = { ...fileBuffersRef.current };
        }
        nextBuffers[managed.documentId] = response.fileBuffer;
      }
    }
    if (nextBuffers !== fileBuffersRef.current) {
      fileBuffersRef.current = nextBuffers;
      setFileBuffers(nextBuffers);
    }

    return collectAppExitImpacts({
      ptyCount,
      documents: fileDocumentsRef.current,
      buffers: fileBuffersRef.current,
      uncertainDocumentIds,
    });
  }, []);

  const getBackupRestoreBlockers = useCallback(async () => {
    backupRestoreInProgressRef.current = true;
    try {
      await Promise.all(
        fileDocumentsRef.current.map((document) =>
          fileOperationFlightsRef.current.waitForSave(document.id),
        ),
      );
      await saveQueueRef.current?.flush();

      const sessions = Object.values(useAppStore.getState().ptySessionsById);
      const runningPtyCount = sessions.filter(
        (session) => session.state === "running",
      ).length;
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
      openFileCount: fileDocumentsRef.current.filter(
        (document) => document.directoryId === directoryId,
      ).length,
      runningPtyCount: Object.values(
        useAppStore.getState().ptySessionsById,
      ).filter(
        (session) =>
          session.directoryId === directoryId && session.state === "running",
      ).length,
    };
  }, []);

  const cancelBackupRestore = useCallback(() => {
    backupRestoreInProgressRef.current = false;
  }, []);

  const rehydrateWorkspace = useCallback(async () => {
    backupRestoreInProgressRef.current = false;
    fileDocumentsRef.current.forEach((document) =>
      invalidateFileOperationGeneration(document.id),
    );
    saveQueueRef.current = null;
    slotsRef.current = [];
    fileDocumentsRef.current = [];
    fileBuffersRef.current = {};
    treeRef.current = createWorkspacePane(initialPaneId);
    focusedPaneIdRef.current = initialPaneId;
    detachedByInstanceRef.current.clear();
    detachedFilesRef.current.clear();
    pendingDetachedRef.current.clear();
    pendingDetachedFilesRef.current.clear();
    terminalRefs.current.clear();
    contentCoordinatorRef.current.reset();
    useAppStore.getState().clearPtySessions();
    setSlots([]);
    setFileDocuments([]);
    setFileBuffers({});
    setTree(treeRef.current);
    setFocusedPaneId(initialPaneId);
    setWorkspaceTreeRevision((revision) => revision + 1);
    await hydrateWorkspace();
  }, [hydrateWorkspace, initialPaneId]);

  const value = useMemo(
    () => ({
      slots,
      fileDocuments,
      fileBuffers,
      handoffFileIds,
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
      launchSession,
      openProjectFile,
      loadFile,
      activateFile,
      activateUnsupportedContent,
      editFile,
      saveFile,
      closeContents,
      detachFile,
      detachedFileIds,
      focusPane,
      activateSession,
      splitPane,
      splitAndMoveSession,
      splitAndMoveFile,
      moveSession,
      moveFile,
      detachedInstanceIds,
      closingContentKeys,
      hasDetachedSessions: detachedInstanceIds.size > 0,
      isManagedDetachedDrag,
      isManagedDetachedFileDrag,
      detachSession,
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
      rehydrateWorkspace,
      getDirectoryRemovalBlockers,
    }),
    [
      slots,
      fileDocuments,
      fileBuffers,
      handoffFileIds,
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
      launchSession,
      openProjectFile,
      loadFile,
      activateFile,
      activateUnsupportedContent,
      editFile,
      saveFile,
      closeContents,
      detachFile,
      detachedFileIds,
      focusPane,
      activateSession,
      splitPane,
      splitAndMoveSession,
      splitAndMoveFile,
      moveSession,
      moveFile,
      detachedInstanceIds,
      closingContentKeys,
      isManagedDetachedDrag,
      isManagedDetachedFileDrag,
      detachSession,
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
      rehydrateWorkspace,
      getDirectoryRemovalBlockers,
    ],
  );

  return (
    <PtyWorkspaceContext.Provider value={value}>
      {children}
      {closeConfirmationImpacts && (
        <WorkspaceContentCloseDialog
          impacts={closeConfirmationImpacts}
          onCancel={() => resolveCloseConfirmation(false)}
          onConfirm={() => resolveCloseConfirmation(true)}
        />
      )}
      {(hydrationStatus === "ready" || hydrationStatus === "needsReset") && (
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
  );
}

export function usePtyWorkspace() {
  const workspace = useContext(PtyWorkspaceContext);
  if (!workspace) {
    throw new Error("PtyWorkspaceProvider is missing");
  }
  return workspace;
}

function WorkspaceContentCloseDialog({
  impacts,
  onCancel,
  onConfirm,
}: {
  impacts: WorkspaceContentDisposalImpact[];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const runningSessions = impacts.filter(
    (impact) => impact.kind === "runningPty",
  );
  const dirtyFiles = impacts.filter((impact) => impact.kind === "dirtyFile");

  return (
    <div className="app-exit-overlay">
      <section className="app-exit-dialog" role="alertdialog" aria-modal="true">
        <h2>{t("common.confirm")}</h2>
        {runningSessions.length > 0 && (
          <>
            <p>
              {t("pty.confirmCloseMany", { count: runningSessions.length })}
            </p>
            <ul className="app-exit-unsaved-files">
              {runningSessions.map((impact) => (
                <li key={`pty:${impact.title}`}>{impact.title}</li>
              ))}
            </ul>
          </>
        )}
        {dirtyFiles.length > 0 && (
          <>
            <p>{t("workspaceFiles.discardChanges")}</p>
            <ul className="app-exit-unsaved-files">
              {dirtyFiles.map((impact) => (
                <li key={`file:${impact.title}`}>{impact.title}</li>
              ))}
            </ul>
          </>
        )}
        <div className="app-exit-actions">
          <button className="ghost-button" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button className="primary-button" onClick={onConfirm}>
            {t("common.confirm")}
          </button>
        </div>
      </section>
    </div>
  );
}

export function WorkspaceLayoutControls() {
  const {
    hydrationStatus,
    getCurrentPresetLayout,
    applyWorkspaceLayoutPreset,
  } = usePtyWorkspace();

  if (hydrationStatus !== "ready") return null;
  return (
    <WorkspaceLayoutManager
      getCurrentLayout={getCurrentPresetLayout}
      onApply={applyWorkspaceLayoutPreset}
    />
  );
}

export function PtyWorkspaceRegion() {
  const { t } = useTranslation();
  const {
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
    focusPane,
    activateSession,
    splitPane,
    splitAndMoveSession,
    splitAndMoveFile,
    moveSession,
    moveFile,
    hasDetachedSessions,
    isManagedDetachedDrag,
    isManagedDetachedFileDrag,
    closingContentKeys,
    detachSession,
    detachFile,
    closeEmptyPane,
    updateSplitRatio,
    retryHydration,
    resetWorkspace,
    activateFile,
    activateUnsupportedContent,
    closeContents,
    editFile,
    loadFile,
    saveFile,
  } = usePtyWorkspace();
  const { data: directories } = useDirectories();
  const ptySessionsById = useAppStore((state) => state.ptySessionsById);
  const selectedDirectoryId = useAppStore((state) => state.selectedDirectoryId);

  if (hydrationStatus === "loading") {
    return (
      <section
        className="pty-workspace-region"
        aria-label={t("pty.panelLabel")}
      >
        <div className="pty-workspace-loading" role="status">
          {t("pty.layoutLoading")}
        </div>
      </section>
    );
  }

  if (hydrationStatus === "loadFailed") {
    return (
      <section
        className="pty-workspace-region"
        aria-label={t("pty.panelLabel")}
      >
        <div className="pty-workspace-recovery-notice" role="alert">
          <p>{t("pty.layoutLoadFailed", { error: hydrationError })}</p>
          <button
            type="button"
            className="pty-layout-action"
            onClick={retryHydration}
          >
            {t("pty.retryLayoutRead")}
          </button>
        </div>
      </section>
    );
  }

  const workspacePanes = listWorkspacePanes(tree);

  return (
    <section className="pty-workspace-region" aria-label={t("pty.panelLabel")}>
      {hydrationStatus === "needsReset" && (
        <div className="pty-workspace-recovery-notice" role="status">
          <p>{t("pty.layoutNeedsReset", { reason: hydrationError })}</p>
          {layoutResetError && (
            <p>{t("pty.layoutResetFailed", { error: layoutResetError })}</p>
          )}
          <button
            type="button"
            className="pty-layout-action"
            disabled={layoutResetPending}
            onClick={() => {
              if (!window.confirm(t("pty.confirmLayoutReset"))) return;
              void resetWorkspace().catch((reason) =>
                toast.error(formatAppError(reason, t)),
              );
            }}
          >
            {layoutResetPending
              ? t("pty.layoutResetPending")
              : t("pty.resetLayout")}
          </button>
        </div>
      )}
      {hydrationStatus === "ready" && layoutSaveError && (
        <div className="pty-workspace-recovery-notice" role="status">
          {t("pty.layoutSaveFailed", { error: layoutSaveError })}
        </div>
      )}
      <div className="pty-workspace-tree">
        <WorkspaceTreeView
          key={workspaceTreeRevision}
          node={tree}
          slots={slots}
          fileDocuments={fileDocuments}
          fileBuffers={fileBuffers}
          handoffFileIds={handoffFileIds}
          detachedFileIds={detachedFileIds}
          closingContentKeys={closingContentKeys}
          focusedPaneId={focusedPaneId}
          portalTargets={portalTargets}
          canCloseEmptyPane={listWorkspacePanes(tree).length > 1}
          selectedDirectoryId={selectedDirectoryId}
          directories={directories ?? []}
          ptySessionsById={ptySessionsById}
          workspacePanes={workspacePanes}
          onFocusPane={focusPane}
          onActivateSession={activateSession}
          onActivateFile={activateFile}
          onActivateUnsupportedContent={activateUnsupportedContent}
          onCloseContents={closeContents}
          onDetachFile={(documentId) => {
            void detachFile(documentId).catch((reason) =>
              toast.error(formatAppError(reason, t)),
            );
          }}
          onMoveFile={moveFile}
          onEditFile={editFile}
          onLoadFile={loadFile}
          onSaveFile={saveFile}
          onSplitPane={splitPane}
          onSplitAndMoveSession={splitAndMoveSession}
          onSplitAndMoveFile={splitAndMoveFile}
          onMoveSession={moveSession}
          hasDetachedSessions={hasDetachedSessions}
          isManagedDetachedDrag={isManagedDetachedDrag}
          isManagedDetachedFileDrag={isManagedDetachedFileDrag}
          onDetachSession={(instanceId) => {
            void detachSession(instanceId).catch((reason) =>
              toast.error(formatAppError(reason, t)),
            );
          }}
          onCloseEmptyPane={closeEmptyPane}
          onSplitResize={updateSplitRatio}
        />
      </div>
    </section>
  );
}

function WorkspaceLayoutManager({
  getCurrentLayout,
  onApply,
}: {
  getCurrentLayout: () => WorkspaceLayoutDocument;
  onApply: (presetId: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [presets, setPresets] = useState<WorkspaceLayoutPresetSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [confirmation, setConfirmation] = useState<{
    kind: "overwrite" | "delete";
    id: string;
  } | null>(null);

  const refreshPresets = useCallback(async () => {
    setLoading(true);
    try {
      setPresets(await listWorkspaceLayoutPresets());
    } catch (reason) {
      toast.error(
        t("pty.layoutActionFailed", { error: formatAppError(reason, t) }),
      );
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (open) void refreshPresets();
  }, [open, refreshPresets]);

  const runAction = useCallback(
    async (action: () => Promise<void>, successMessage?: string) => {
      setBusy(true);
      try {
        await action();
        if (successMessage) toast.success(successMessage);
      } catch (reason) {
        toast.error(
          t("pty.layoutActionFailed", { error: formatAppError(reason, t) }),
        );
      } finally {
        setBusy(false);
      }
    },
    [t],
  );

  const savePreset = () => {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    void runAction(async () => {
      await createWorkspaceLayoutPreset(trimmedName, getCurrentLayout());
      setName("");
      await refreshPresets();
    }, t("pty.layoutSaved"));
  };

  const applyPreset = (presetId: string) => {
    void runAction(async () => {
      await onApply(presetId);
      setOpen(false);
      setConfirmation(null);
    }, t("pty.layoutApplied"));
  };

  const saveRename = (presetId: string) => {
    const trimmedName = editingName.trim();
    if (!trimmedName) return;
    void runAction(async () => {
      const renamed = await renameWorkspaceLayoutPreset(presetId, trimmedName);
      if (!renamed) throw new Error(t("pty.layoutPresetMissing"));
      setEditingId(null);
      setEditingName("");
      await refreshPresets();
    }, t("pty.layoutRenamed"));
  };

  const confirmPresetAction = () => {
    if (!confirmation) return;
    const action = confirmation;
    void runAction(
      async () => {
        if (action.kind === "overwrite") {
          const updated = await updateWorkspaceLayoutPreset(
            action.id,
            getCurrentLayout(),
          );
          if (!updated) throw new Error(t("pty.namedLayoutMissing"));
        } else {
          const deleted = await deleteWorkspaceLayoutPreset(action.id);
          if (!deleted) throw new Error(t("pty.namedLayoutMissing"));
        }
        setConfirmation(null);
        await refreshPresets();
      },
      action.kind === "overwrite"
        ? t("pty.layoutOverwritten")
        : t("pty.layoutDeleted"),
    );
  };

  const closePopover = useCallback(() => {
    setOpen(false);
    setConfirmation(null);
    setEditingId(null);
  }, []);

  return (
    <div className="pty-workspace-toolbar">
      <button
        ref={anchorRef}
        type="button"
        className="pty-layout-toolbar-button window-titlebar-compact-button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <LayoutTemplate size={15} />
        {t("pty.layouts")}
        <ChevronDown size={14} />
      </button>
      {open && (
        <AnchoredPopover
          anchorRef={anchorRef}
          ariaLabel={t("pty.layouts")}
          className="workspace-layout-popover"
          onClose={closePopover}
          preferredWidth={440}
          header={
            <div className="workspace-layout-popover-heading">
              <span>{t("pty.namedLayouts")}</span>
              <button
                type="button"
                className="icon-button"
                aria-label={t("pty.closeLayoutManager")}
                onClick={closePopover}
              >
                <X size={15} />
              </button>
            </div>
          }
        >
          <form
            className="workspace-layout-save-form"
            onSubmit={(event) => {
              event.preventDefault();
              savePreset();
            }}
          >
            <input
              value={name}
              maxLength={64}
              placeholder={t("pty.layoutNamePlaceholder")}
              aria-label={t("pty.layoutNamePlaceholder")}
              onChange={(event) => setName(event.currentTarget.value)}
            />
            <button
              type="submit"
              className="pty-layout-action"
              disabled={busy || !name.trim()}
            >
              <Save size={14} />
              {t("pty.saveLayout")}
            </button>
          </form>
          <div className="workspace-layout-list" aria-live="polite">
            {loading ? (
              <p className="muted">{t("pty.layoutsLoading")}</p>
            ) : presets.length === 0 ? (
              <p className="muted">{t("pty.noNamedLayouts")}</p>
            ) : (
              presets.map((preset) => (
                <div className="workspace-layout-preset" key={preset.id}>
                  <div className="workspace-layout-preset-main">
                    {editingId === preset.id ? (
                      <form
                        className="workspace-layout-rename-form"
                        onSubmit={(event) => {
                          event.preventDefault();
                          saveRename(preset.id);
                        }}
                      >
                        <input
                          autoFocus
                          value={editingName}
                          maxLength={64}
                          aria-label={t("pty.layoutNamePlaceholder")}
                          onChange={(event) =>
                            setEditingName(event.currentTarget.value)
                          }
                        />
                        <button
                          type="submit"
                          className="icon-button"
                          title={t("common.save")}
                          disabled={busy || !editingName.trim()}
                        >
                          <Check size={15} />
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          title={t("common.cancel")}
                          onClick={() => setEditingId(null)}
                        >
                          <X size={15} />
                        </button>
                      </form>
                    ) : (
                      <strong title={preset.name}>{preset.name}</strong>
                    )}
                    <button
                      type="button"
                      className="pty-layout-action"
                      disabled={busy || editingId === preset.id}
                      onClick={() => applyPreset(preset.id)}
                    >
                      <LayoutTemplate size={14} />
                      {t("pty.applyLayout")}
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      title={t("pty.renameLayout")}
                      aria-label={t("pty.renameLayout")}
                      disabled={busy || editingId !== null}
                      onClick={() => {
                        setEditingId(preset.id);
                        setEditingName(preset.name);
                      }}
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      title={t("pty.overwriteLayout")}
                      aria-label={t("pty.overwriteLayout")}
                      disabled={busy || editingId !== null}
                      onClick={() =>
                        setConfirmation({ kind: "overwrite", id: preset.id })
                      }
                    >
                      <Save size={14} />
                    </button>
                    <button
                      type="button"
                      className="icon-button danger"
                      title={t("pty.deleteLayout")}
                      aria-label={t("pty.deleteLayout")}
                      disabled={busy || editingId !== null}
                      onClick={() =>
                        setConfirmation({ kind: "delete", id: preset.id })
                      }
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                  {confirmation?.id === preset.id && (
                    <div className="workspace-layout-confirmation">
                      <span>
                        {confirmation.kind === "overwrite"
                          ? t("pty.confirmOverwriteLayout", {
                              name: preset.name,
                            })
                          : t("pty.confirmDeleteLayout", {
                              name: preset.name,
                            })}
                      </span>
                      <button
                        type="button"
                        className="pty-layout-action"
                        disabled={busy}
                        onClick={() => setConfirmation(null)}
                      >
                        {t("common.cancel")}
                      </button>
                      <button
                        type="button"
                        className="pty-layout-action is-primary"
                        disabled={busy}
                        onClick={confirmPresetAction}
                      >
                        {t("pty.confirmLayoutAction")}
                      </button>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </AnchoredPopover>
      )}
    </div>
  );
}

interface WorkspaceTreeViewProps {
  node: WorkspaceNode;
  slots: PtyWorkspaceSlot[];
  fileDocuments: WorkspaceFileDocument[];
  fileBuffers: Record<string, WorkspaceFileBuffer>;
  handoffFileIds: Set<string>;
  detachedFileIds: Set<string>;
  closingContentKeys: Set<string>;
  focusedPaneId: string;
  portalTargets: Record<string, HTMLDivElement>;
  canCloseEmptyPane: boolean;
  selectedDirectoryId: number | null;
  directories: { id: number; name: string }[];
  ptySessionsById: Record<string, PtySession>;
  workspacePanes: WorkspacePane[];
  onFocusPane: (paneId: string) => void;
  onActivateSession: (paneId: string, instanceId: string) => void;
  onActivateFile: (paneId: string, documentId: string) => void;
  onActivateUnsupportedContent: (
    paneId: string,
    content: Extract<WorkspacePaneContentRef, { kind: "unknown" }>,
  ) => void;
  onCloseContents: (
    contents: WorkspacePaneContentRef[],
    origin: "tab" | "menu" | "stack" | "window",
    onApproved?: () => void,
  ) => Promise<void>;
  onDetachFile: (documentId: string) => void;
  onMoveFile: (
    sourcePaneId: string,
    destinationPaneId: string,
    documentId: string,
  ) => void;
  onEditFile: (documentId: string, content: string) => void;
  onLoadFile: (documentId: string) => Promise<void>;
  onSaveFile: (documentId: string) => Promise<void>;
  onSplitPane: (paneId: string, direction: SplitDirection) => void;
  onSplitAndMoveSession: (
    paneId: string,
    instanceId: string,
    direction: SplitDirection,
  ) => void;
  onSplitAndMoveFile: (
    paneId: string,
    documentId: string,
    direction: SplitDirection,
  ) => void;
  onMoveSession: (
    sourcePaneId: string,
    destinationPaneId: string,
    instanceId: string,
  ) => void;
  hasDetachedSessions: boolean;
  isManagedDetachedDrag: (instanceId: string, windowLabel: string) => boolean;
  isManagedDetachedFileDrag: (
    documentId: string,
    windowLabel: string,
  ) => boolean;
  onDetachSession: (instanceId: string) => void;
  onCloseEmptyPane: (paneId: string) => void;
  onSplitResize: (
    splitId: string,
    sizes: number[],
    phase: SplitResizePhase,
  ) => void;
}

function WorkspaceTreeView(props: WorkspaceTreeViewProps) {
  const { node, onSplitResize } = props;
  const splitHostRef = useRef<HTMLDivElement | null>(null);
  const allotmentRef = useRef<AllotmentHandle | null>(null);
  const appliedSplitRatioRef = useRef<{
    splitId: string;
    direction: SplitDirection;
    ratio: number;
  } | null>(null);
  const applyingSplitRatioRef = useRef(false);
  const splitId = node.kind === "split" ? node.id : null;
  const splitDirection = node.kind === "split" ? node.direction : null;
  const splitRatio = node.kind === "split" ? node.ratio : null;

  useEffect(() => {
    if (splitId === null || splitDirection === null || splitRatio === null) {
      appliedSplitRatioRef.current = null;
      return;
    }

    const applied = appliedSplitRatioRef.current;
    if (
      applied?.splitId === splitId &&
      applied.direction === splitDirection &&
      Math.abs(applied.ratio - splitRatio) < 0.0001
    ) {
      return;
    }

    // The workspace can be mounted while its parent view is hidden or before
    // the native window has completed its restored geometry. Wait until the
    // split host has a real extent instead of permanently missing the one-shot
    // initial ratio application.
    const applyRatio = () => {
      const host = splitHostRef.current;
      const allotment = allotmentRef.current;
      if (!host || !allotment) return;

      const appliedNow = appliedSplitRatioRef.current;
      if (
        appliedNow?.splitId === splitId &&
        appliedNow.direction === splitDirection &&
        Math.abs(appliedNow.ratio - splitRatio) < 0.0001
      ) {
        return;
      }

      const extent =
        splitDirection === "horizontal" ? host.clientWidth : host.clientHeight;
      if (extent <= WORKSPACE_SASH_SIZE) return;

      const sizes = workspaceSplitSizes(splitRatio, extent);
      if (!isUsableWorkspaceSplitSizes(sizes)) return;

      applyingSplitRatioRef.current = true;
      try {
        allotment.resize(sizes);
        appliedSplitRatioRef.current = {
          splitId,
          direction: splitDirection,
          ratio: splitRatio,
        };
      } catch (error) {
        // Keep the workspace mounted; preferredSize remains the safe fallback.
        console.error("Failed to apply the workspace split ratio", error);
      } finally {
        applyingSplitRatioRef.current = false;
      }
    };

    let frame = 0;
    const scheduleApply = () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      // Allotment registers its pane views after the initial layout effect.
      // The frame also lets ResizeObserver report dimensions after visibility
      // and native window restoration have settled.
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        applyRatio();
      });
    };

    const host = splitHostRef.current;
    const observer =
      host && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(scheduleApply)
        : null;
    if (host) observer?.observe(host);
    scheduleApply();

    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [splitDirection, splitId, splitRatio]);

  if (node.kind === "pane") return <WorkspacePaneView {...props} pane={node} />;

  const firstSize = String(Math.round(node.ratio * 10000) / 100) + "%";
  const secondSize = String(Math.round((1 - node.ratio) * 10000) / 100) + "%";
  return (
    <div ref={splitHostRef} className="pty-workspace-split-host">
      <Allotment
        // A split can be promoted from a nested child to the workspace root
        // when its sibling pane closes. Remount Allotment when the tree node
        // identity changes so its cached orientation and pane sizes cannot
        // leak across the new topology.
        key={`${node.id}:${node.direction}`}
        ref={allotmentRef}
        id={node.id}
        className="pty-workspace-split"
        vertical={node.direction === "vertical"}
        proportionalLayout
        separator
        onChange={(sizes) => {
          if (!applyingSplitRatioRef.current) {
            onSplitResize(node.id, sizes, "change");
          }
        }}
        onDragEnd={(sizes) => {
          const total = sizes.reduce((sum, size) => sum + size, 0);
          if (isUsableWorkspaceSplitSizes(sizes) && total > 0) {
            appliedSplitRatioRef.current = {
              splitId: node.id,
              direction: node.direction,
              ratio: sizes[0] / total,
            };
          }
          onSplitResize(node.id, sizes, "dragEnd");
        }}
      >
        <Allotment.Pane
          minSize={
            node.direction === "horizontal"
              ? MIN_WORKSPACE_PANE_WIDTH
              : MIN_WORKSPACE_PANE_HEIGHT
          }
          preferredSize={firstSize}
        >
          <WorkspaceTreeView {...props} node={node.first} />
        </Allotment.Pane>
        <Allotment.Pane
          minSize={
            node.direction === "horizontal"
              ? MIN_WORKSPACE_PANE_WIDTH
              : MIN_WORKSPACE_PANE_HEIGHT
          }
          preferredSize={secondSize}
        >
          <WorkspaceTreeView {...props} node={node.second} />
        </Allotment.Pane>
      </Allotment>
    </div>
  );
}

function WorkspacePaneView({
  pane,
  slots,
  fileDocuments,
  fileBuffers,
  handoffFileIds,
  detachedFileIds,
  closingContentKeys,
  focusedPaneId,
  portalTargets,
  canCloseEmptyPane,
  selectedDirectoryId,
  directories,
  ptySessionsById,
  workspacePanes,
  onFocusPane,
  onActivateSession,
  onActivateFile,
  onActivateUnsupportedContent,
  onCloseContents,
  onDetachFile,
  onMoveFile,
  onEditFile,
  onLoadFile,
  onSaveFile,
  onSplitPane,
  onSplitAndMoveSession,
  onSplitAndMoveFile,
  onMoveSession,
  hasDetachedSessions,
  isManagedDetachedDrag,
  isManagedDetachedFileDrag,
  onDetachSession,
  onCloseEmptyPane,
}: WorkspaceTreeViewProps & {
  pane: Extract<WorkspaceNode, { kind: "pane" }>;
}) {
  const { t } = useTranslation();
  const paneName = t("pty.paneNumber", { number: pane.paneNumber });
  const presentationContext: WorkspaceContentPresentationContext = {
    directories,
    ptySlots: slots,
    ptySessionsById,
    fileDocuments,
    fileBuffers,
    selectedDirectoryId,
  };
  const paneSlots = listWorkspacePaneContents(pane, "pty")
    .map((content) =>
      content.kind === "pty"
        ? slots.find((slot) => slot.instanceId === content.slotId)
        : undefined,
    )
    .filter((slot): slot is PtyWorkspaceSlot => Boolean(slot));
  const activeFileId =
    pane.activeContent?.kind === "file" ? pane.activeContent.documentId : null;
  const activeFile = activeFileId
    ? fileDocuments.find((document) => document.id === activeFileId)
    : undefined;
  const paneContentEntries: ResolvedPaneContent[] = pane.contents.flatMap(
    (content): ResolvedPaneContent[] => {
      if (content.kind === "pty") {
        const slot = slots.find(
          (candidate) => candidate.instanceId === content.slotId,
        );
        return slot ? [{ content, slot }] : [];
      }
      if (content.kind === "unknown") return [{ content }];
      const file = fileDocuments.find(
        (candidate) => candidate.id === content.documentId,
      );
      return file && !detachedFileIds.has(file.id) ? [{ content, file }] : [];
    },
  );
  const contentSequence = splitWorkspaceContentSequence(
    paneContentEntries,
    pane.activeContent,
  );
  const activeContentEntry = contentSequence.active;
  const activeFileBuffer = activeFileId ? fileBuffers[activeFileId] : undefined;
  const activeSlot =
    activeContentEntry && "slot" in activeContentEntry
      ? activeContentEntry.slot
      : undefined;
  const paneContentSignature = paneContentEntries
    .map((entry) => workspaceContentReactKey(entry.content))
    .join("|");
  const tabStripRef = useRef<HTMLDivElement>(null);
  const [tabStripWidth, setTabStripWidth] = useState(0);
  const [tabWidths, setTabWidths] = useState<Record<string, number>>({});
  useLayoutEffect(() => {
    const tabStrip = tabStripRef.current;
    if (!tabStrip || typeof ResizeObserver === "undefined") return;

    const measure = () => {
      const nextStripWidth = tabStrip.clientWidth;
      setTabStripWidth((current) =>
        Math.abs(current - nextStripWidth) < 1 ? current : nextStripWidth,
      );
      const nextWidths: Record<string, number> = {};
      tabStrip
        .querySelectorAll<HTMLElement>("[data-workspace-content-key]")
        .forEach((element) => {
          const key = element.dataset.workspaceContentKey;
          const width = element.getBoundingClientRect().width;
          if (key && width > 0) nextWidths[key] = width;
        });
      setTabWidths((current) => {
        const keys = Object.keys(nextWidths);
        if (
          keys.length === Object.keys(current).length &&
          keys.every(
            (key) => Math.abs((current[key] ?? 0) - nextWidths[key]) < 1,
          )
        ) {
          return current;
        }
        return nextWidths;
      });
    };

    const observer = new ResizeObserver(measure);
    observer.observe(tabStrip);
    tabStrip
      .querySelectorAll<HTMLElement>("[data-workspace-content-key]")
      .forEach((element) => observer.observe(element));
    measure();
    return () => observer.disconnect();
  }, [paneContentSignature]);
  const activeTabIndex = Math.max(
    0,
    paneContentEntries.findIndex(
      (entry) =>
        pane.activeContent &&
        workspaceContentReactKey(entry.content) ===
          workspaceContentReactKey(pane.activeContent),
    ),
  );
  const tabPartition = partitionVisibleTabs(
    paneContentEntries.map(
      (entry) =>
        tabWidths[workspaceContentReactKey(entry.content)] ??
        Number.POSITIVE_INFINITY,
    ),
    tabStripWidth,
    activeTabIndex,
    40,
  );
  const visibleTabIndexes = new Set(tabPartition.visible);
  const visibleTabEntries = paneContentEntries.filter((_, index) =>
    visibleTabIndexes.has(index),
  );
  const stackedTabEntries = paneContentEntries.filter(
    (_, index) => !visibleTabIndexes.has(index),
  );
  const related = paneSlots.some(
    (slot) => slot.directoryId === selectedDirectoryId,
  );
  const focused = pane.id === focusedPaneId;
  const contentRef = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<{
    target:
      | { kind: "pty"; instanceId: string }
      | { kind: "file"; documentId: string };
    x: number;
    y: number;
  } | null>(null);
  const [dropActive, setDropActive] = useState(false);

  useEffect(() => {
    if (activeFileId && !activeFileBuffer) {
      void onLoadFile(activeFileId).catch((reason) =>
        toast.error(formatAppError(reason, t)),
      );
    }
  }, [activeFileBuffer, activeFileId, onLoadFile]);

  useEffect(() => {
    const clearDropTarget = () => setDropActive(false);
    window.addEventListener("drop", clearDropTarget, true);
    window.addEventListener("dragend", clearDropTarget);
    return () => {
      window.removeEventListener("drop", clearDropTarget, true);
      window.removeEventListener("dragend", clearDropTarget);
    };
  }, []);

  const requestSplit = (direction: SplitDirection, instanceId?: string) => {
    if (instanceId) onActivateSession(pane.id, instanceId);
    const bounds = contentRef.current?.parentElement?.getBoundingClientRect();
    if (
      !bounds ||
      !canSplitWorkspacePane(bounds.width, bounds.height, direction)
    ) {
      toast.info(
        t("pty.splitTooSmall", {
          axis: direction === "horizontal" ? t("pty.width") : t("pty.height"),
          size: minimumWorkspacePaneExtent(direction),
        }),
      );
      return;
    }
    onSplitPane(pane.id, direction);
  };

  const requestSplitAndMove = (
    direction: SplitDirection,
    instanceId: string,
  ) => {
    const bounds = contentRef.current?.parentElement?.getBoundingClientRect();
    if (
      !bounds ||
      !canSplitWorkspacePane(bounds.width, bounds.height, direction)
    ) {
      toast.info(
        t("pty.splitTooSmall", {
          axis: direction === "horizontal" ? t("pty.width") : t("pty.height"),
          size: minimumWorkspacePaneExtent(direction),
        }),
      );
      return;
    }
    onSplitAndMoveSession(pane.id, instanceId, direction);
  };

  const renderContentTab = (
    entry: ResolvedPaneContent,
    measureOnly = false,
  ) => {
    const { content } = entry;
    const key = workspaceContentReactKey(content);
    const isClosing = closingContentKeys.has(key);
    const presentation = presentWorkspaceContent(content, presentationContext);
    const adapter =
      content.kind === "unknown"
        ? undefined
        : tryGetWorkspaceContentAdapter(content.kind);
    const title = presentation.title;
    const isActive =
      pane.activeContent !== null &&
      pane.activeContent !== undefined &&
      workspaceContentReactKey(pane.activeContent) === key;
    const projectId = workspaceContentProjectContext(
      content,
      presentationContext,
    );

    return (
      <WorkspaceContentTab
        key={key}
        contentKey={key}
        measureOnly={measureOnly}
        title={title}
        active={isActive}
        related={projectId !== null && projectId === selectedDirectoryId}
        closeLabel={t(presentation.closeLabelKey)}
        closeAccessibleName={
          adapter
            ? t(adapter.labels.closeCurrent, { name: title })
            : t("workspaceContent.closeUnsupported")
        }
        draggable={content.kind !== "unknown" && !isClosing && !!adapter}
        onDragStart={(event) => {
          if (isClosing) return;
          if (content.kind === "pty") {
            beginWorkspaceSessionDrag(event, pane.id, content.slotId);
            return;
          }
          if (content.kind === "unknown" || isClosing || !adapter) return;
          const payload = encodeWorkspaceContentDrag({
            kind: content.kind,
            contentId: content.documentId,
            sourcePaneId: pane.id,
            sourceWindowLabel: "main",
          });
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData(WORKSPACE_CONTENT_DRAG_TYPE, payload);
          event.dataTransfer.setData("text/plain", payload);
        }}
        onActivate={() => {
          if (content.kind === "pty")
            onActivateSession(pane.id, content.slotId);
          else if (content.kind === "file")
            onActivateFile(pane.id, content.documentId);
          else onActivateUnsupportedContent(pane.id, content);
        }}
        onRequestClose={() => void onCloseContents([content], "tab")}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (content.kind === "unknown" || isClosing) return;
          onFocusPane(pane.id);
          setContextMenu({
            target:
              content.kind === "pty"
                ? { kind: "pty", instanceId: content.slotId }
                : { kind: "file", documentId: content.documentId },
            x: event.clientX,
            y: event.clientY,
          });
        }}
      >
        {presentation.icon}
        {isClosing ? (
          <span
            className="pty-pane-tab-status terminating"
            title={t("pty.terminating")}
            aria-label={t("pty.terminating")}
          />
        ) : presentation.status && presentation.status !== "dirty" ? (
          <span
            className={clsx("pty-pane-tab-status", {
              running: presentation.status === "running",
              failed: presentation.status === "failed",
            })}
            aria-hidden="true"
          />
        ) : null}
        <span
          className="pty-pane-tab-title"
          title={presentation.tooltip ?? title}
        >
          {content.kind === "file" ? title.split(/[\\/]/).pop() : title}
          {presentation.status === "dirty" ? " •" : ""}
        </span>
      </WorkspaceContentTab>
    );
  };

  return (
    <section
      className={clsx("pty-workspace-pane", {
        focused,
        related,
        "drop-active": dropActive,
      })}
      aria-label={paneName}
      onMouseDown={() => onFocusPane(pane.id)}
      onDragOverCapture={(event) => {
        const types = Array.from(event.dataTransfer.types);
        if (
          !types.includes(PTY_SESSION_DRAG_TYPE) &&
          !types.includes(WORKSPACE_CONTENT_DRAG_TYPE) &&
          !(hasDetachedSessions && types.includes("text/plain"))
        ) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        setDropActive(true);
      }}
      onDragLeaveCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setDropActive(false);
        }
      }}
      onDropCapture={(event) => {
        const types = Array.from(event.dataTransfer.types);
        if (
          !types.includes(PTY_SESSION_DRAG_TYPE) &&
          !types.includes(WORKSPACE_CONTENT_DRAG_TYPE) &&
          !(hasDetachedSessions && types.includes("text/plain"))
        ) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        setDropActive(false);
        const contentPayload = parseWorkspaceContentDrag(
          event.dataTransfer.getData(WORKSPACE_CONTENT_DRAG_TYPE),
        );
        if (
          contentPayload?.sourceWindowLabel === "main" &&
          "sourcePaneId" in contentPayload
        ) {
          if (contentPayload.kind === "file") {
            onMoveFile(
              contentPayload.sourcePaneId,
              pane.id,
              contentPayload.contentId,
            );
          } else {
            onMoveSession(
              contentPayload.sourcePaneId,
              pane.id,
              contentPayload.contentId,
            );
          }
          return;
        }
        if (
          contentPayload?.kind === "pty" &&
          contentPayload.sourceWindowLabel !== "main" &&
          isManagedDetachedDrag(
            contentPayload.contentId,
            contentPayload.sourceWindowLabel,
          )
        ) {
          void emitWorkspaceContentWindowEvent(
            contentPayload.sourceWindowLabel,
            "pty-return-drop-requested",
            {
              instanceId: contentPayload.contentId,
              targetPaneId: pane.id,
            },
          ).catch((reason) =>
            toast.error(
              t("pty.returnFailed", { error: formatAppError(reason, t) }),
            ),
          );
          return;
        }
        if (
          contentPayload?.kind === "file" &&
          contentPayload.sourceWindowLabel !== "main" &&
          isManagedDetachedFileDrag(
            contentPayload.contentId,
            contentPayload.sourceWindowLabel,
          )
        ) {
          void emitWorkspaceContentWindowEvent(
            contentPayload.sourceWindowLabel,
            "workspace-file-window-return-drop-requested",
            {
              documentId: contentPayload.contentId,
              targetPaneId: pane.id,
            },
          ).catch((reason) => toast.error(formatAppError(reason, t)));
          return;
        }
        const payloadText =
          event.dataTransfer.getData(PTY_SESSION_DRAG_TYPE) ||
          event.dataTransfer.getData("text/plain");
        const payload = parsePtySessionDrag(payloadText);
        if (!payload) return;
        if (payload.sourceWindowLabel === "main" && "sourcePaneId" in payload) {
          onMoveSession(payload.sourcePaneId, pane.id, payload.instanceId);
        } else if (
          isManagedDetachedDrag(payload.instanceId, payload.sourceWindowLabel)
        ) {
          void emitWorkspaceContentWindowEvent(
            payload.sourceWindowLabel,
            "pty-return-drop-requested",
            {
              instanceId: payload.instanceId,
              targetPaneId: pane.id,
            },
          ).catch((reason) =>
            toast.error(
              t("pty.returnFailed", { error: formatAppError(reason, t) }),
            ),
          );
        }
      }}
    >
      {dropActive && (
        <div className="pty-pane-drop-label" aria-hidden="true">
          {t("pty.dropIntoPane", { pane: paneName })}
        </div>
      )}
      <header className="pty-pane-header">
        <div className="pty-pane-identity">
          <span className="pty-pane-name">{paneName}</span>
          {pane.contents.length === 0 && (
            <span className="pty-pane-empty-title">{t("pty.emptyPane")}</span>
          )}
        </div>
        <div className="pty-pane-tabs" ref={tabStripRef}>
          <div
            className="pty-pane-active-tablist"
            role="tablist"
            aria-label={t("pty.paneSessions")}
          >
            {visibleTabEntries.map((entry) => renderContentTab(entry))}
          </div>
          {stackedTabEntries.length > 0 && (
            <PaneSessionStack
              side="overflow"
              sourcePaneId={pane.id}
              entries={stackedTabEntries}
              directories={directories}
              ptySlots={slots}
              ptySessionsById={ptySessionsById}
              fileDocuments={fileDocuments}
              fileBuffers={fileBuffers}
              selectedDirectoryId={selectedDirectoryId}
              closingContentKeys={closingContentKeys}
              onActivate={(entry) => {
                if (entry.content.kind === "pty")
                  onActivateSession(pane.id, entry.content.slotId);
                else if (entry.content.kind === "file")
                  onActivateFile(pane.id, entry.content.documentId);
                else onActivateUnsupportedContent(pane.id, entry.content);
              }}
              onCloseContent={(entry) =>
                void onCloseContents([entry.content], "stack")
              }
              onContextMenu={(entry, x, y) => {
                if (entry.content.kind === "unknown") return;
                onFocusPane(pane.id);
                setContextMenu({
                  target:
                    entry.content.kind === "pty"
                      ? { kind: "pty", instanceId: entry.content.slotId }
                      : { kind: "file", documentId: entry.content.documentId },
                  x,
                  y,
                });
              }}
            />
          )}
          <div className="pty-pane-tab-measurements" aria-hidden="true">
            {stackedTabEntries.map((entry) => renderContentTab(entry, true))}
          </div>
        </div>
        <div className="pty-pane-actions">
          {canCloseEmptyPane &&
            paneSlots.length === 0 &&
            pane.contents.length === 0 && (
              <button
                type="button"
                className="icon-button"
                title={t("pty.closeEmptyPane")}
                aria-label={t("pty.closeEmptyPane")}
                onClick={(event) => {
                  event.stopPropagation();
                  onCloseEmptyPane(pane.id);
                }}
              >
                <X size={14} />
              </button>
            )}
          <button
            type="button"
            className="icon-button"
            title={t("pty.splitRight")}
            aria-label={t("pty.splitRight")}
            onClick={(event) => {
              event.stopPropagation();
              requestSplit("horizontal");
            }}
          >
            <Columns2 size={15} />
          </button>
          <button
            type="button"
            className="icon-button"
            title={t("pty.splitDown")}
            aria-label={t("pty.splitDown")}
            onClick={(event) => {
              event.stopPropagation();
              requestSplit("vertical");
            }}
          >
            <Rows2 size={15} />
          </button>
        </div>
      </header>
      <div className="pty-pane-content" ref={contentRef}>
        <WorkspaceContentView
          content={pane.activeContent}
          fileDocument={activeFile}
          fileBuffer={activeFileBuffer}
          readOnly={Boolean(activeFileId && handoffFileIds.has(activeFileId))}
          ptyPortalTarget={
            activeSlot ? portalTargets[activeSlot.instanceId] : undefined
          }
          onEditFile={onEditFile}
          onSaveFile={onSaveFile}
          onCloseUnsupported={() => {
            if (pane.activeContent) {
              void onCloseContents([pane.activeContent], "tab");
            }
          }}
        />
        {!activeContentEntry && (
          <div className="pty-workspace-empty">{t("pty.empty")}</div>
        )}
      </div>
      {contextMenu &&
        (() => {
          const target = contextMenu.target;
          const isPty = target.kind === "pty";
          const targetId = isPty ? target.instanceId : target.documentId;
          const targetSlot = isPty
            ? slots.find((slot) => slot.instanceId === targetId)
            : undefined;
          const targetFile = isPty
            ? undefined
            : fileDocuments.find((file) => file.id === targetId);
          const targetContent: WorkspacePaneContentRef = isPty
            ? { kind: "pty", slotId: targetId }
            : { kind: "file", documentId: targetId };
          if (!targetSlot && !targetFile) return null;
          const paneContentRefs = paneContentEntries.map(
            (entry) => entry.content,
          );
          const otherContents = workspacePaneOtherContents(
            paneContentRefs,
            targetContent,
          );
          const itemTitle = presentWorkspaceContent(
            targetContent,
            presentationContext,
          ).title;
          const adapter = tryGetWorkspaceContentAdapter(target.kind);
          if (!adapter) return null;
          const labels = {
            menu: t(adapter.labels.menu),
            closeCurrent: (name: string) =>
              t(adapter.labels.closeCurrent, { name }),
            closeOthers: (count: number) =>
              t(adapter.labels.closeOthers, { count }),
            closeAll: (count: number) => t(adapter.labels.closeAll, { count }),
            splitAndMoveRight: t(adapter.labels.splitAndMoveRight),
            splitAndMoveDown: t(adapter.labels.splitAndMoveDown),
          };
          const requestCloseContents = (
            contents: WorkspacePaneContentRef[],
            afterApproval?: () => void,
          ) => {
            setContextMenu(null);
            void onCloseContents(contents, "menu", afterApproval);
          };
          return (
            <WorkspaceContentContextMenu
              title={itemTitle}
              x={contextMenu.x}
              y={contextMenu.y}
              labels={labels}
              allowDetach={
                targetFile !== undefined ||
                (targetSlot?.sessionId
                  ? ptySessionsById[targetSlot.sessionId]?.state === "running"
                  : false)
              }
              otherContentCount={otherContents.length}
              paneContentCount={paneContentRefs.length}
              otherPanes={workspacePanes
                .filter((candidate) => candidate.id !== pane.id)
                .map((candidate) => ({
                  id: candidate.id,
                  title: workspacePaneTitle(
                    candidate,
                    presentationContext,
                    t("pty.paneNumber", { number: candidate.paneNumber }),
                    t("pty.emptyPane"),
                  ),
                }))}
              onClose={() => setContextMenu(null)}
              onSplit={(direction) => {
                setContextMenu(null);
                if (targetSlot)
                  onActivateSession(pane.id, targetSlot.instanceId);
                requestSplit(direction);
              }}
              onSplitAndMove={(direction) => {
                setContextMenu(null);
                if (targetSlot)
                  requestSplitAndMove(direction, targetSlot.instanceId);
                else if (targetFile) {
                  const bounds =
                    contentRef.current?.parentElement?.getBoundingClientRect();
                  if (
                    !bounds ||
                    !canSplitWorkspacePane(
                      bounds.width,
                      bounds.height,
                      direction,
                    )
                  ) {
                    toast.info(
                      t("pty.splitTooSmall", {
                        axis:
                          direction === "horizontal"
                            ? t("pty.width")
                            : t("pty.height"),
                        size: minimumWorkspacePaneExtent(direction),
                      }),
                    );
                    return;
                  }
                  onSplitAndMoveFile(pane.id, targetFile.id, direction);
                }
              }}
              onMoveToPane={(destinationPaneId) => {
                setContextMenu(null);
                if (targetSlot)
                  onMoveSession(
                    pane.id,
                    destinationPaneId,
                    targetSlot.instanceId,
                  );
                else if (targetFile)
                  onMoveFile(pane.id, destinationPaneId, targetFile.id);
              }}
              onDetach={() => {
                setContextMenu(null);
                if (targetSlot) onDetachSession(targetSlot.instanceId);
                else if (targetFile) onDetachFile(targetFile.id);
              }}
              onCloseCurrent={() => requestCloseContents([targetContent])}
              onCloseOthers={() =>
                requestCloseContents(otherContents, () => {
                  if (targetSlot)
                    onActivateSession(pane.id, targetSlot.instanceId);
                  if (targetFile) onActivateFile(pane.id, targetFile.id);
                })
              }
              onCloseAll={() => requestCloseContents(paneContentRefs)}
            />
          );
        })()}
    </section>
  );
}

function PaneSessionStack({
  side,
  sourcePaneId,
  entries,
  directories,
  ptySlots,
  ptySessionsById,
  fileDocuments,
  fileBuffers,
  selectedDirectoryId,
  closingContentKeys,
  onActivate,
  onCloseContent,
  onContextMenu,
}: {
  side: "before" | "after" | "overflow";
  sourcePaneId: string;
  entries: ResolvedPaneContent[];
  directories: { id: number; name: string }[];
  ptySlots: PtyWorkspaceSlot[];
  ptySessionsById: Record<string, PtySession>;
  fileDocuments: WorkspaceFileDocument[];
  fileBuffers: Record<string, WorkspaceFileBuffer | undefined>;
  selectedDirectoryId: number | null;
  closingContentKeys: Set<string>;
  onActivate: (entry: ResolvedPaneContent) => void;
  onCloseContent: (entry: ResolvedPaneContent) => void;
  onContextMenu: (entry: ResolvedPaneContent, x: number, y: number) => void;
}) {
  const { t } = useTranslation();
  const presentationContext: WorkspaceContentPresentationContext = {
    directories,
    ptySlots,
    ptySessionsById,
    fileDocuments,
    fileBuffers,
    selectedDirectoryId,
  };
  const anchorRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const label = t(
    side === "before"
      ? "pty.previousSessions"
      : side === "after"
        ? "pty.nextSessions"
        : "pty.overflowContents",
    { count: entries.length },
  );
  const heading = t(
    side === "before"
      ? "pty.previousSessionsHeading"
      : side === "after"
        ? "pty.nextSessionsHeading"
        : "pty.overflowContentsHeading",
  );

  useEffect(() => {
    if (!open) return;
    const boundedIndex = Math.min(focusedIndex, entries.length - 1);
    setFocusedIndex(Math.max(0, boundedIndex));
    listRef.current
      ?.querySelector<HTMLButtonElement>(
        `[data-stack-index="${Math.max(0, boundedIndex)}"]`,
      )
      ?.focus();
  }, [entries.length, focusedIndex, open]);

  const focusStackEntry = (index: number) => {
    if (entries.length === 0) return;
    const nextIndex = (index + entries.length) % entries.length;
    setFocusedIndex(nextIndex);
    listRef.current
      ?.querySelector<HTMLButtonElement>(`[data-stack-index="${nextIndex}"]`)
      ?.focus();
  };

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="pty-pane-stack-trigger"
        title={label}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        <Layers size={14} aria-hidden="true" />
        <span>{entries.length}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open && (
        <AnchoredPopover
          anchorRef={anchorRef}
          ariaLabel={heading}
          className="pty-pane-session-stack-popover"
          onClose={() => setOpen(false)}
          preferredWidth={320}
        >
          <div
            ref={listRef}
            className="pty-pane-session-stack-list"
            aria-label={heading}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                focusStackEntry(focusedIndex + 1);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                focusStackEntry(focusedIndex - 1);
              } else if (event.key === "Delete") {
                event.preventDefault();
                onCloseContent(entries[focusedIndex]);
              }
            }}
          >
            {entries.map((entry, index) => {
              const slot = "slot" in entry ? entry.slot : undefined;
              const presentation = presentWorkspaceContent(
                entry.content,
                presentationContext,
              );
              const title = presentation.title;
              const contentKey = workspaceContentReactKey(entry.content);
              const isClosing = closingContentKeys.has(contentKey);
              const closeLabel = t(presentation.closeLabelKey);
              const adapter =
                entry.content.kind === "unknown"
                  ? undefined
                  : tryGetWorkspaceContentAdapter(entry.content.kind);
              const closeAccessibleName = adapter
                ? t(adapter.labels.closeCurrent, { name: title })
                : t("workspaceContent.closeUnsupported");

              return (
                <div
                  className="pty-pane-session-stack-entry"
                  key={contentKey}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setOpen(false);
                    if (
                      entry.content.kind === "unknown" ||
                      isClosing ||
                      !adapter
                    )
                      return;
                    onContextMenu(entry, event.clientX, event.clientY);
                  }}
                >
                  <button
                    type="button"
                    className="pty-pane-session-stack-session"
                    title={title}
                    aria-label={title}
                    data-stack-index={index}
                    tabIndex={index === focusedIndex ? 0 : -1}
                    draggable={
                      entry.content.kind !== "unknown" &&
                      !isClosing &&
                      !!adapter
                    }
                    onFocus={() => setFocusedIndex(index)}
                    onDragStart={(event) => {
                      if (isClosing) return;
                      if (slot) {
                        beginWorkspaceSessionDrag(
                          event,
                          sourcePaneId,
                          slot.instanceId,
                        );
                      } else if ("file" in entry) {
                        const payload = encodeWorkspaceContentDrag({
                          kind: "file",
                          contentId: entry.file.id,
                          sourcePaneId,
                          sourceWindowLabel: "main",
                        });
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData(
                          WORKSPACE_CONTENT_DRAG_TYPE,
                          payload,
                        );
                        event.dataTransfer.setData("text/plain", payload);
                      }
                    }}
                    onDragEnd={() => setOpen(false)}
                    onClick={() => {
                      setOpen(false);
                      onActivate(entry);
                    }}
                  >
                    {presentation.icon}
                    {isClosing ? (
                      <span
                        className="pty-pane-tab-status terminating"
                        title={t("pty.terminating")}
                        aria-label={t("pty.terminating")}
                      />
                    ) : presentation.status ? (
                      <span
                        className={clsx("pty-pane-tab-status", {
                          running: presentation.status === "running",
                          failed: presentation.status === "failed",
                          dirty: presentation.status === "dirty",
                        })}
                        aria-hidden="true"
                      />
                    ) : null}
                    <span>{title}</span>
                  </button>
                  <button
                    type="button"
                    className="pty-pane-session-stack-close"
                    title={closeLabel}
                    aria-label={closeAccessibleName}
                    onClick={() => onCloseContent(entry)}
                  >
                    <X size={13} />
                  </button>
                </div>
              );
            })}
          </div>
        </AnchoredPopover>
      )}
    </>
  );
}

function beginWorkspaceSessionDrag(
  event: ReactDragEvent<HTMLElement>,
  sourcePaneId: string,
  instanceId: string,
) {
  event.dataTransfer.effectAllowed = "move";
  const payload = encodeWorkspaceContentDrag({
    kind: "pty",
    contentId: instanceId,
    sourcePaneId,
    sourceWindowLabel: "main",
  });
  const legacyPayload = encodePtySessionDrag({
    instanceId,
    sourcePaneId,
    sourceWindowLabel: "main",
  });
  event.dataTransfer.setData(WORKSPACE_CONTENT_DRAG_TYPE, payload);
  event.dataTransfer.setData(PTY_SESSION_DRAG_TYPE, legacyPayload);
  event.dataTransfer.setData("text/plain", payload);
}

function workspacePtyKey(slotId: string): string {
  return workspaceContentKey({ kind: "pty", slotId });
}

function workspaceFileKey(documentId: string): string {
  return workspaceContentKey({ kind: "file", documentId });
}

function workspaceContentReactKey(content: WorkspacePaneContentRef): string {
  return workspaceContentKey(content);
}

function workspacePaneTitle(
  pane: WorkspacePane,
  presentationContext: WorkspaceContentPresentationContext,
  paneName: string,
  emptyPaneLabel: string,
): string {
  const activeContent = pane.activeContent;
  const targetTitle = activeContent
    ? presentWorkspaceContent(activeContent, presentationContext).title
    : emptyPaneLabel;
  return `${paneName} · ${targetTitle}`;
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

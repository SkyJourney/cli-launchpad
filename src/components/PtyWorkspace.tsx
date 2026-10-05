import clsx from "clsx";
import { Allotment, type AllotmentHandle } from "allotment";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
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
  FileText,
} from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
  type DragEvent as ReactDragEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useDirectories } from "../hooks/queries";
import {
  emitWorkspaceContentWindowEvent,
  getWorkspaceContentWindowLabelPrefix,
  listenWorkspaceContentWindowEvent,
} from "../lib/workspaceContentWindowProtocol";
import {
  type WorkspaceNode,
  activateWorkspaceSession,
  activateWorkspaceFile,
  deactivateWorkspaceFile,
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
  moveWorkspaceFileToPane,
  moveWorkspaceSession,
  MIN_WORKSPACE_PANE_HEIGHT,
  MIN_WORKSPACE_PANE_WIDTH,
  minimumWorkspacePaneExtent,
  isUsableWorkspaceSplitSizes,
  nextWorkspaceSessionSequence,
  removeEmptyWorkspacePane,
  removeWorkspaceSession,
  remapWorkspaceFileIds,
  setWorkspaceSplitRatio,
  splitAndMoveWorkspaceSession,
  splitAndMoveWorkspaceFile,
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
import { matchesDetachedWindow } from "../lib/ptySessionLifecycle";
import { matchesWorkspaceFileWindow } from "../lib/workspaceFileWindow";
import {
  clearPendingWorkspaceContentWindows,
  promotePendingWorkspaceContentWindow,
  registerPendingWorkspaceContentWindow,
  takePendingWorkspaceContentWindow,
} from "../lib/workspaceContentWindowRegistry";
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
  openProjectFile as openProjectFileContent,
  saveProjectTextFile,
  type Directory,
  type WorkspaceFileDocument,
  type PtySession,
  type ToolKey,
  type WorkspaceLayoutDocument,
  type WorkspaceLayoutSlot,
  type WorkspaceLayoutPresetSummary,
  type WorkspaceSlotStateKind,
  type WorkspacePaneContentRef,
} from "../lib/tauri";
import {
  createWorkspaceLayoutDocument,
  isWorkspaceApplyStateCurrent,
  markWorkspaceSlotsRestored,
  removeEndedWorkspaceSlots,
  rehomeDetachedWorkspaceSlots,
  restoreWorkspaceLayoutApplyPlan,
  restoreWorkspaceRuntimeSnapshot,
  WorkspaceLayoutSaveQueue,
} from "../lib/workspaceLayoutPersistence";
import { getTerminalTitleLabel, TOOLS } from "../lib/tools";
import {
  createWorkspaceFileBuffer,
  completeWorkspaceFileSave,
  editWorkspaceFileBuffer,
  beginWorkspaceFileSave,
  failWorkspaceFileSave,
  isWorkspaceFileBufferNewer,
  markWorkspaceFileSaveConflict,
  WorkspaceFileOperationFlights,
} from "../lib/workspaceFileBuffer";
import { closeWorkspaceFileState } from "../lib/workspaceFileClose";
import { WorkspaceContentCoordinator } from "../lib/workspaceContentCoordinator";
import type { WorkspaceContentHandoffPayloadByKind } from "../lib/workspaceContentLifecycle";
import { useAppStore } from "../store/appStore";
import { AnchoredPopover } from "./AnchoredPopover";
import {
  WorkspaceContentView,
  getWorkspaceContentAdapter,
} from "./WorkspaceContentView";
import { WorkspaceContentTab } from "./WorkspaceContentTab";
import { WorkspaceContentContextMenu } from "./WorkspaceContentContextMenu";
import type { WorkspaceFileBuffer } from "../lib/workspaceFileBuffer";
import {
  closeWorkspaceContentBatch,
  disposeWorkspaceContent,
  shouldCloseWorkspaceContent,
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

interface ManagedDetachedWindow extends DetachedWindowRecord {
  window: WebviewWindow;
}

interface PendingDetachedWindow extends DetachedWindowRecord {
  token: string;
  resolve: () => void;
  reject: (reason: Error) => void;
  timer: number;
  window: WebviewWindow;
  handoffContext: WorkspaceContentHandoffHookContext<"pty">;
  handoffPayload: WorkspaceContentHandoffPayloadByKind["pty"];
}

interface DetachedWindowReadyEvent extends DetachedWindowRecord {}

interface PtyReturnRequestEvent extends DetachedWindowRecord {
  token: string;
  targetPaneId?: string;
}

interface PendingWorkspaceFileWindow {
  documentId: string;
  token: string;
  windowLabel: string;
  sourcePaneId?: string;
  window: WebviewWindow;
  timer: number;
  resolve: () => void;
  reject: (reason: Error) => void;
  attached: boolean;
  handoffContext?: WorkspaceContentHandoffHookContext<"file">;
  handoffPayload?: WorkspaceContentHandoffPayloadByKind["file"];
}

type ResolvedPaneContent =
  | {
      content: Extract<WorkspacePaneContentRef, { kind: "pty" }>;
      slot: PtyWorkspaceSlot;
    }
  | {
      content: Extract<WorkspacePaneContentRef, { kind: "file" }>;
      file: WorkspaceFileDocument;
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
  editFile: (documentId: string, content: string) => void;
  saveFile: (documentId: string) => Promise<void>;
  closeFile: (documentId: string, skipDirtyConfirmation?: boolean) => void;
  closeFiles: (documentIds: string[], skipDirtyConfirmation?: boolean) => void;
  closePtySlots: (
    slots: PtyWorkspaceSlot[],
    skipConfirmation?: boolean,
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
    reason?: "closed" | "ended",
    options?: { lifecycleManaged?: boolean },
  ) => void;
  recordSession: (instanceId: string, session: PtySession | null) => void;
}

const PtyWorkspaceContext = createContext<PtyWorkspaceContextValue | null>(
  null,
);

export function PtyWorkspaceProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { data: directories } = useDirectories();
  const [hydrationStatus, setHydrationStatus] =
    useState<PtyWorkspaceHydrationStatus>("loading");
  const [hydrationError, setHydrationError] = useState<string | null>(null);
  const [layoutSaveError, setLayoutSaveError] = useState<string | null>(null);
  const [layoutResetError, setLayoutResetError] = useState<string | null>(null);
  const [layoutResetPending, setLayoutResetPending] = useState(false);
  const [initialPaneId] = useState<string>(() => crypto.randomUUID());
  const [slots, setSlots] = useState<PtyWorkspaceSlot[]>([]);
  const [fileDocuments, setFileDocuments] = useState<WorkspaceFileDocument[]>(
    [],
  );
  const [fileBuffers, setFileBuffers] = useState<
    Record<string, WorkspaceFileBuffer>
  >({});
  const [handoffFileIds, setHandoffFileIds] = useState<Set<string>>(
    () => new Set(),
  );
  const handoffFileIdsRef = useRef(handoffFileIds);
  const [detachedFileIds, setDetachedFileIds] = useState<Set<string>>(
    () => new Set(),
  );
  const detachedFileIdsRef = useRef(detachedFileIds);
  const [tree, setTree] = useState<WorkspaceNode>(() =>
    createWorkspacePane(initialPaneId),
  );
  const [workspaceTreeRevision, setWorkspaceTreeRevision] = useState(0);
  const [focusedPaneId, setFocusedPaneId] = useState(initialPaneId);
  const [portalTargets, setPortalTargets] = useState<
    Record<string, HTMLDivElement>
  >({});
  const [detachedInstanceIds, setDetachedInstanceIds] = useState<Set<string>>(
    () => new Set(),
  );
  const detachedInstanceIdsRef = useRef(detachedInstanceIds);
  const terminalRefs = useRef(new Map<string, PtyTerminalHandle>());
  const saveQueueRef = useRef<WorkspaceLayoutSaveQueue | null>(null);
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
  const detachedByInstanceRef = useRef(
    new Map<string, ManagedDetachedWindow>(),
  );
  const pendingDetachedRef = useRef(new Map<string, PendingDetachedWindow>());
  const detachedFilesRef = useRef(
    new Map<string, PendingWorkspaceFileWindow>(),
  );
  const contentCoordinatorRef = useRef(new WorkspaceContentCoordinator());
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
  detachedInstanceIdsRef.current = detachedInstanceIds;
  detachedFileIdsRef.current = detachedFileIds;
  handoffFileIdsRef.current = handoffFileIds;
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
        (reason) => setLayoutSaveError(String(reason)),
        () => setLayoutSaveError(null),
      ),
    [],
  );

  const persistWorkspaceSnapshot = useCallback(
    (treeOverride?: WorkspaceNode) => {
      if (hydrationStatusRef.current !== "ready") return;
      const queue = saveQueueRef.current;
      if (!queue) return;

      const persistedSlots: WorkspaceLayoutSlot[] = slotsRef.current.map(
        (slot) => toWorkspaceLayoutSlot(slot, directories ?? []),
      );
      queue.enqueue(
        createWorkspaceLayoutDocument({
          tree: treeOverride ?? treeRef.current,
          focusedPaneId: focusedPaneIdRef.current,
          slots: persistedSlots,
          documents: fileDocumentsRef.current,
          detachedSlotIds: [...detachedInstanceIdsRef.current].filter(
            (instanceId) =>
              !listWorkspacePanes(treeOverride ?? treeRef.current).some(
                (pane) =>
                  hasWorkspaceContent(pane, {
                    kind: "pty",
                    slotId: instanceId,
                  }),
              ),
          ),
        }),
      );
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
          throw new Error(t("pty.layoutDataMissing"));
        }
        const restored = rehomeDetachedWorkspaceSlots(
          restoreWorkspaceRuntimeSnapshot(read.layout),
        );
        const restoredSnapshot = removeEndedWorkspaceSlots({
          ...restored,
          slots: markWorkspaceSlotsRestored(restored.slots, read.slotStates),
        });
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
        setDetachedFileIds(new Set());
        detachedFileIdsRef.current = new Set();
        detachedFilesRef.current.clear();
        clearPendingWorkspaceContentWindows(
          pendingDetachedRef.current,
          (pending) => {
            contentCoordinatorRef.current.failHandoff(
              { kind: "pty", slotId: pending.instanceId },
              "detachCancelled",
              pending.token,
            );
            pending.reject(new Error(t("pty.detachedStateChanged")));
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
            pending.reject(new Error(t("pty.detachedStateChanged")));
            void pending.window.destroy().catch(() => undefined);
          },
        );
        setTree(restoredSnapshot.tree);
        setFocusedPaneId(restoredSnapshot.focusedPaneId);
        setDetachedInstanceIds(new Set());
        detachedInstanceIdsRef.current = new Set();
      }

      saveQueueRef.current = createSaveQueue(revision);
      setLayoutSaveError(null);
      setHydrationStatus("ready");
    } catch (reason) {
      if (requestId !== hydrationRequestRef.current) return;
      setHydrationError(String(reason));
      setHydrationStatus("loadFailed");
    }
  }, [createSaveQueue, t]);

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
        void saveQueueRef.current?.flush();
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
      setLayoutResetError(String(reason));
      throw reason;
    } finally {
      setLayoutResetPending(false);
    }
  }, [createSaveQueue]);

  const applyWorkspaceLayoutPreset = useCallback(
    async (presetId: string) => {
      if (hydrationStatusRef.current !== "ready") return;
      const expectedState = {
        tree: treeRef.current,
        slots: slotsRef.current,
        focusedPaneId: focusedPaneIdRef.current,
        detachedSlotIds: detachedInstanceIdsRef.current,
      };
      const activeDetachedIds = [...detachedInstanceIdsRef.current];
      let activeTree = expectedState.tree;
      for (const instanceId of activeDetachedIds) {
        activeTree = removeWorkspaceSession(activeTree, instanceId);
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
        detachedSlotIds: activeDetachedIds,
      });
      const plan = await planApplyWorkspaceLayoutPreset(presetId, activeLayout);
      if (
        !isWorkspaceApplyStateCurrent(expectedState, {
          tree: treeRef.current,
          slots: slotsRef.current,
          focusedPaneId: focusedPaneIdRef.current,
          detachedSlotIds: detachedInstanceIdsRef.current,
        })
      ) {
        throw new Error(t("pty.layoutChangedDuringApply"));
      }
      const restored = restoreWorkspaceLayoutApplyPlan(plan);
      const restoredSlots: PtyWorkspaceSlot[] = restored.slots;
      const restoredDocuments = [...(restored.documents ?? [])];
      const currentDocuments = fileDocumentsRef.current;
      new Set([
        ...currentDocuments.map((document) => document.id),
        ...restoredDocuments.map((document) => document.id),
      ]).forEach(invalidateFileOperationGeneration);
      const currentDocumentByIdentity = new Map(
        currentDocuments.map((document) => [
          `${document.directoryId}:${document.relativePath}`,
          document,
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
      const restoredPaths = new Set(
        restoredDocuments.map(
          (document) => `${document.directoryId}:${document.relativePath}`,
        ),
      );
      for (const document of fileDocumentsRef.current) {
        const identity = `${document.directoryId}:${document.relativePath}`;
        if (restoredPaths.has(identity)) continue;
        const targetPane = listWorkspacePanes(restoredTree)[0];
        restoredTree = addWorkspaceFileToPane(
          restoredTree,
          targetPane.id,
          document.id,
        );
        restoredDocuments.push(document);
        restoredPaths.add(identity);
      }

      slotsRef.current = restoredSlots;
      treeRef.current = restoredTree;
      focusedPaneIdRef.current = restored.focusedPaneId;
      setSlots(restoredSlots);
      setFileDocuments(restoredDocuments);
      fileDocumentsRef.current = restoredDocuments;
      setTree(restoredTree);
      setFocusedPaneId(restored.focusedPaneId);
      const nextDetachedIds = new Set(restored.detachedSlotIds);
      detachedInstanceIdsRef.current = nextDetachedIds;
      setDetachedInstanceIds(nextDetachedIds);
    },
    [directories, t],
  );

  const commitTree = useCallback((next: WorkspaceNode) => {
    treeRef.current = next;
    setTree(next);
  }, []);

  const openProjectFile = useCallback(
    (
      directoryId: number,
      directoryPath: string,
      relativePath: string,
    ): Promise<void> => {
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
            await openProjectFileContent(directoryId, relativePath),
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
            await openProjectFileContent(directoryId, relativePath),
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
          detachedFilesRef.current.get(document.id) ??
          pendingDetachedFilesRef.current.get(document.id);
        if (detachedWindow) {
          await detachedWindow.window.setFocus().catch(() => undefined);
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
        commitTree(
          hasWorkspaceContent(pane, { kind: "file", documentId: document.id })
            ? activateWorkspaceFile(treeRef.current, pane.id, document.id)
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
      focusedPaneIdRef.current = paneId;
      setFocusedPaneId(paneId);
      commitTree(activateWorkspaceFile(treeRef.current, paneId, documentId));
    },
    [commitTree],
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
    if (handoffFileIdsRef.current.has(documentId)) return;
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
          toast.error(String(reason));
        }
      }),
    [],
  );

  const saveFile = useCallback(
    (documentId: string) =>
      fileOperationFlightsRef.current.save(documentId, async () => {
        if (handoffFileIdsRef.current.has(documentId)) return;
        const document = fileDocumentsRef.current.find(
          (entry) => entry.id === documentId,
        );
        const buffer = fileBuffersRef.current[documentId];
        if (
          !document ||
          !buffer ||
          buffer.kind !== "text" ||
          buffer.content === buffer.savedContent ||
          buffer.saving
        ) {
          return;
        }
        const ownerAtStart = contentCoordinatorRef.current.get({
          kind: "file",
          documentId,
        });
        const ownerGeneration = ownerAtStart?.generation;
        const operationGeneration = getFileOperationGeneration(documentId);
        const submitted = beginWorkspaceFileSave(buffer);
        fileBuffersRef.current = {
          ...fileBuffersRef.current,
          [documentId]: submitted,
        };
        setFileBuffers(fileBuffersRef.current);
        const currentRequestIsOwned = () => {
          const currentDocument = fileDocumentsRef.current.find(
            (entry) => entry.id === documentId,
          );
          const currentBuffer = fileBuffersRef.current[documentId];
          const currentOwner = contentCoordinatorRef.current.get({
            kind: "file",
            documentId,
          });
          return (
            Boolean(currentDocument) &&
            currentDocument?.directoryId === document.directoryId &&
            currentDocument?.relativePath === document.relativePath &&
            currentBuffer?.epoch === submitted.epoch &&
            operationGeneration === getFileOperationGeneration(documentId) &&
            (ownerGeneration === undefined ||
              currentOwner?.generation === ownerGeneration)
          );
        };
        try {
          const result = await saveProjectTextFile(
            document.directoryId,
            document.relativePath,
            submitted.content,
            submitted.revision,
          );
          if (!currentRequestIsOwned()) return;
          if (result.kind === "conflict") {
            const current = fileBuffersRef.current[documentId];
            if (!current) return;
            const next = {
              ...fileBuffersRef.current,
              [documentId]: markWorkspaceFileSaveConflict(current, submitted),
            };
            fileBuffersRef.current = next;
            setFileBuffers(next);
            toast.error(t("workspaceFiles.saveConflict"), {
              action: {
                label: t("workspaceFiles.reload"),
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
        } catch (reason) {
          if (!currentRequestIsOwned()) return;
          const current = fileBuffersRef.current[documentId];
          if (!current) return;
          const next = {
            ...fileBuffersRef.current,
            [documentId]: failWorkspaceFileSave(current, submitted),
          };
          fileBuffersRef.current = next;
          setFileBuffers(next);
          toast.error(String(reason));
        }
      }),
    [reloadFile, t],
  );

  const closeFiles = useCallback(
    (requestedDocumentIds: string[], skipDirtyConfirmation = false) => {
      const documentIds = [...new Set(requestedDocumentIds)].filter(
        (documentId) =>
          fileDocumentsRef.current.some(
            (document) => document.id === documentId,
          ) && !detachedFileIdsRef.current.has(documentId),
      );
      if (documentIds.length === 0) return;
      let discardAccepted = skipDirtyConfirmation;
      const confirmDiscard = () => {
        if (discardAccepted) return true;
        discardAccepted = window.confirm(t("workspaceFiles.discardChanges"));
        return discardAccepted;
      };
      const requestId = crypto.randomUUID();
      const adapter = getWorkspaceContentAdapter("file");
      const requests = documentIds.map((documentId) => {
        const buffer = fileBuffersRef.current[documentId];
        const content = { kind: "file", documentId } as const;
        const pane = listWorkspacePanes(treeRef.current).find((candidate) =>
          hasWorkspaceContent(candidate, content),
        );
        if (!pane) return null;
        contentCoordinatorRef.current.ensureAttached(content, {
          kind: "pane",
          windowLabel: "main",
          paneId: pane.id,
        });
        return {
          content,
          beforeClose: () =>
            shouldCloseWorkspaceContent(adapter.lifecycle?.beforeClose, {
              isDirty: Boolean(
                buffer && buffer.content !== buffer.savedContent,
              ),
              confirmDiscard,
            }),
        };
      });
      if (requests.some((request) => request === null)) return;
      const validRequests = requests.filter(
        (request): request is NonNullable<typeof request> => request !== null,
      );
      void closeWorkspaceContentBatch({
        coordinator: contentCoordinatorRef.current,
        requestId,
        requests: validRequests,
        dispose: (context) => {
          if (context.content.kind === "file") {
            return adapter.lifecycle?.dispose?.(
              context as WorkspaceContentDisposeContext<"file">,
            );
          }
        },
        execute: () => {
          const next = closeWorkspaceFileState(
            {
              tree: treeRef.current,
              documents: fileDocumentsRef.current,
              buffers: fileBuffersRef.current,
            },
            documentIds,
          );
          commitTree(next.tree);
          fileDocumentsRef.current = next.documents;
          setFileDocuments(next.documents);
          fileBuffersRef.current = next.buffers;
          setFileBuffers(next.buffers);
          next.closedDocumentIds.forEach(invalidateFileOperationGeneration);
          return next.closedDocumentIds.map((documentId) => ({
            kind: "file" as const,
            documentId,
          }));
        },
      }).catch((reason) =>
        console.error("Failed to close workspace files", reason),
      );
    },
    [commitTree, t],
  );
  const closeFile = useCallback(
    (documentId: string, skipDirtyConfirmation = false) =>
      closeFiles([documentId], skipDirtyConfirmation),
    [closeFiles],
  );

  const detachFile = useCallback(
    async (documentId: string) => {
      if (
        detachedFilesRef.current.has(documentId) ||
        handoffFileIdsRef.current.has(documentId)
      ) {
        return;
      }
      const nextHandoffIds = new Set(handoffFileIdsRef.current).add(documentId);
      handoffFileIdsRef.current = nextHandoffIds;
      setHandoffFileIds(nextHandoffIds);
      let token: string | undefined;
      let lifecycleStarted = false;
      try {
        if (!fileBuffersRef.current[documentId]) await loadFile(documentId);
        await fileOperationFlightsRef.current.waitForSave(documentId);
        const fileBuffer = fileBuffersRef.current[documentId];
        const fileDocument = fileDocumentsRef.current.find(
          (document) => document.id === documentId,
        );
        if (!fileDocument || !fileBuffer || fileBuffer.saving) {
          throw new Error(t("workspaceFiles.loadingFile"));
        }
        const sourcePane = listWorkspacePanes(treeRef.current).find((pane) =>
          hasWorkspaceContent(pane, { kind: "file", documentId }),
        );
        if (!sourcePane) throw new Error(t("workspaceFiles.loadingFile"));
        token = crypto.randomUUID();
        const windowLabel = `${getWorkspaceContentWindowLabelPrefix("file")}${crypto.randomUUID()}`;
        const handoffToken = token;
        const lifecycle = contentCoordinatorRef.current.beginDetach(
          { kind: "file", documentId },
          { kind: "pane", windowLabel: "main", paneId: sourcePane.id },
          { kind: "window", windowLabel },
          handoffToken,
        );
        if (lifecycle?.outcome !== "changed") {
          throw new Error(t("pty.detachedMoveUnavailable"));
        }
        lifecycleStarted = true;
        const childUrl = new URL(window.location.href);
        childUrl.search = "";
        childUrl.hash = "";
        childUrl.searchParams.set("detachedFileId", documentId);
        childUrl.searchParams.set("fileHandoffToken", handoffToken);
        childUrl.searchParams.set("sourcePaneId", sourcePane.id);
        await new Promise<void>((resolve, reject) => {
          const child = createWorkspaceContentWindow({
            label: windowLabel,
            url: `${childUrl.pathname}${childUrl.search}${childUrl.hash}`,
            title:
              fileDocument.relativePath.split("/").pop() ??
              fileDocument.relativePath,
          });
          registerPendingWorkspaceContentWindow({
            pending: pendingDetachedFilesRef.current,
            key: documentId,
            timeoutMs: WORKSPACE_CONTENT_WINDOW_HANDOFF_TIMEOUT_MS,
            onTimeout: () => {
              void child.destroy().catch(() => undefined);
              reject(new Error(t("pty.detachedStartTimedOut")));
            },
            record: {
              documentId,
              token: handoffToken,
              windowLabel,
              sourcePaneId: sourcePane.id,
              window: child,
              resolve,
              reject,
              attached: false,
            },
          });
          void child.once("tauri://error", (event) => {
            const pending = takePendingWorkspaceContentWindow(
              pendingDetachedFilesRef.current,
              documentId,
              windowLabel,
            );
            if (!pending) return;
            reject(
              new Error(
                event.payload == null
                  ? t("pty.detachedCreateFailed")
                  : String(event.payload),
              ),
            );
          });
        });
      } catch (reason) {
        if (lifecycleStarted && token) {
          contentCoordinatorRef.current.failHandoff(
            { kind: "file", documentId },
            "detachFailed",
            token,
          );
        }
        throw reason;
      } finally {
        const restoredHandoffIds = new Set(handoffFileIdsRef.current);
        restoredHandoffIds.delete(documentId);
        handoffFileIdsRef.current = restoredHandoffIds;
        setHandoffFileIds(restoredHandoffIds);
      }
    },
    [loadFile, t],
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

  const setFocusedPane = useCallback((paneId: string) => {
    focusedPaneIdRef.current = paneId;
    setFocusedPaneId(paneId);
  }, []);

  const focusPane = useCallback(
    (paneId: string) => {
      const pane = findWorkspacePane(treeRef.current, paneId);
      if (!pane) return;
      setFocusedPane(paneId);
      const activeSlot = slotsRef.current.find(
        (slot) =>
          slot.instanceId ===
          (pane.activeContent?.kind === "pty"
            ? pane.activeContent.slotId
            : null),
      );
      if (activeSlot && !isInvalidRestoredSlotState(activeSlot.restoredState)) {
        const state = useAppStore.getState();
        if (
          state.view !== "detail" ||
          state.selectedDirectoryId !== activeSlot.directoryId
        ) {
          state.openDirectory(activeSlot.directoryId);
        }
      }
    },
    [setFocusedPane],
  );

  const removeSlot = useCallback(
    (
      instanceId: string,
      reason: "closed" | "ended" = "ended",
      options: { lifecycleManaged?: boolean } = {},
    ) => {
      const content = { kind: "pty", slotId: instanceId } as const;
      const lifecycleManaged = options.lifecycleManaged !== false;
      if (lifecycleManaged && reason === "closed") {
        const pane = listWorkspacePanes(treeRef.current).find((candidate) =>
          hasWorkspaceContent(candidate, content),
        );
        if (pane) {
          contentCoordinatorRef.current.ensureAttached(content, {
            kind: "pane",
            windowLabel: "main",
            paneId: pane.id,
          });
        }
        const requestId = crypto.randomUUID();
        if (
          contentCoordinatorRef.current.approveClose(content, requestId)
            ?.outcome === "changed"
        ) {
          void disposeWorkspaceContent({
            coordinator: contentCoordinatorRef.current,
            content,
            requestId,
            reason: "closed",
            dispose: getWorkspaceContentAdapter("pty").lifecycle?.dispose,
          });
        } else {
          void disposeWorkspaceContent({
            coordinator: contentCoordinatorRef.current,
            content,
            reason: "ownerEnded",
            dispose: getWorkspaceContentAdapter("pty").lifecycle?.dispose,
          });
        }
      } else if (lifecycleManaged) {
        void disposeWorkspaceContent({
          coordinator: contentCoordinatorRef.current,
          content,
          reason: "ownerEnded",
          dispose: getWorkspaceContentAdapter("pty").lifecycle?.dispose,
        });
      }
      const removedSlot = slotsRef.current.find(
        (slot) => slot.instanceId === instanceId,
      );
      detachedByInstanceRef.current.delete(instanceId);
      setDetachedInstanceIds((current) => {
        if (!current.has(instanceId)) return current;
        const next = new Set(current);
        next.delete(instanceId);
        return next;
      });
      const nextSlots = slotsRef.current.filter(
        (slot) => slot.instanceId !== instanceId,
      );
      if (removedSlot?.sessionId) removePtySession(removedSlot.sessionId);
      slotsRef.current = nextSlots;
      setSlots(nextSlots);
      const nextTree = removeWorkspaceSession(treeRef.current, instanceId);
      commitTree(nextTree);
      if (!findWorkspacePane(nextTree, focusedPaneIdRef.current)) {
        setFocusedPane(listWorkspacePanes(nextTree)[0].id);
      }
    },
    [commitTree, removePtySession, setFocusedPane],
  );

  const closePtySlots = useCallback(
    async (targetSlots: PtyWorkspaceSlot[], skipConfirmation = false) => {
      if (targetSlots.length === 0) return;
      const ptySessionsById = useAppStore.getState().ptySessionsById;
      const runningCount = targetSlots.filter(
        (slot) =>
          !slot.restoredState &&
          slot.sessionId &&
          ptySessionsById[slot.sessionId]?.state === "running",
      ).length;
      if (
        runningCount > 0 &&
        !skipConfirmation &&
        !window.confirm(t("pty.confirmCloseMany", { count: runningCount }))
      ) {
        return;
      }

      const contents = targetSlots.map((slot) => ({
        slot,
        content: { kind: "pty", slotId: slot.instanceId } as const,
      }));
      const adapter = getWorkspaceContentAdapter("pty");
      const requests = contents.map(({ content }) => {
        const pane = listWorkspacePanes(treeRef.current).find((candidate) =>
          hasWorkspaceContent(candidate, content),
        );
        if (!pane) return null;
        contentCoordinatorRef.current.ensureAttached(content, {
          kind: "pane",
          windowLabel: "main",
          paneId: pane.id,
        });
        return {
          content,
          beforeClose: () =>
            shouldCloseWorkspaceContent(adapter.lifecycle?.beforeClose, {
              isDirty: false,
              confirmDiscard: () => false,
            }),
        };
      });
      if (requests.some((request) => request === null)) return;
      const validRequests = requests.filter(
        (request): request is NonNullable<typeof request> => request !== null,
      );
      const outcomes: Array<{
        slot: PtyWorkspaceSlot;
        result: "closed" | "pending" | "cancelled" | "terminating";
      } | null> = [];
      await closeWorkspaceContentBatch({
        coordinator: contentCoordinatorRef.current,
        requestId: crypto.randomUUID(),
        requests: validRequests,
        dispose: (context) =>
          adapter.lifecycle?.dispose?.(
            context as WorkspaceContentDisposeContext<"pty">,
          ),
        execute: async () => {
          const results = await Promise.all(
            contents.map(async ({ slot, content }) => {
              if (slot.restoredState)
                return { slot, content, result: "closed" as const };
              const terminal = terminalRefs.current.get(slot.instanceId);
              if (!terminal) return null;
              try {
                const result = await terminal.closeSession(false);
                return { slot, content, result };
              } catch {
                return { slot, content, result: "cancelled" as const };
              }
            }),
          );
          outcomes.push(
            ...results.map(
              (result) =>
                result && { slot: result.slot, result: result.result },
            ),
          );
          for (const result of results) {
            if (result?.result === "closed") {
              removeSlot(result.slot.instanceId, "closed", {
                lifecycleManaged: false,
              });
            }
          }
          return results
            .filter((result) => result?.result === "closed")
            .map((result) => result!.content);
        },
      });
      const pendingCount = outcomes.filter(
        (outcome) => outcome?.result === "pending",
      ).length;
      const failedCount = outcomes.filter(
        (outcome) => outcome?.result === "cancelled",
      ).length;
      if (pendingCount > 0) {
        toast.info(t("pty.closePending", { count: pendingCount }));
      }
      if (failedCount > 0) {
        toast.error(t("pty.closeFailedMany", { count: failedCount }));
      }
    },
    [removeSlot, t],
  );

  const launchSession = useCallback(
    (directoryId: number, toolKey: ToolKey, resumeSessionId?: string) => {
      const directory = directories?.find((entry) => entry.id === directoryId);
      if (!directory) {
        toast.error(t("pty.projectUnavailable"));
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
      commitTree(
        addSessionToWorkspacePane(
          treeRef.current,
          targetPane.id,
          slot.instanceId,
        ),
      );
      setFocusedPane(targetPane.id);
    },
    [commitTree, directories, setFocusedPane, t],
  );

  const activateSession = useCallback(
    (paneId: string, instanceId: string) => {
      try {
        commitTree(
          activateWorkspaceSession(treeRef.current, paneId, instanceId),
        );
      } catch {
        return;
      }
      setFocusedPane(paneId);
      const slot = slotsRef.current.find(
        (candidate) => candidate.instanceId === instanceId,
      );
      if (slot && !isInvalidRestoredSlotState(slot.restoredState)) {
        const state = useAppStore.getState();
        if (
          state.view !== "detail" ||
          state.selectedDirectoryId !== slot.directoryId
        ) {
          state.openDirectory(slot.directoryId);
        }
      }
    },
    [commitTree, setFocusedPane],
  );

  const splitPane = useCallback(
    (paneId: string, direction: SplitDirection) => {
      const sourcePane = findWorkspacePane(treeRef.current, paneId);
      if (!sourcePane) return;
      const sourceSlot = slotsRef.current.find(
        (slot) =>
          slot.instanceId ===
          (sourcePane.activeContent?.kind === "pty"
            ? sourcePane.activeContent.slotId
            : null),
      );
      if (sourceSlot) {
        const state = useAppStore.getState();
        if (state.selectedDirectoryId !== sourceSlot.directoryId) {
          state.openDirectory(sourceSlot.directoryId);
        }
      }
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
    [commitTree, setFocusedPane],
  );

  const splitAndMoveSession = useCallback(
    (paneId: string, instanceId: string, direction: SplitDirection) => {
      const sourcePane = findWorkspacePane(treeRef.current, paneId);
      const slot = slotsRef.current.find(
        (candidate) => candidate.instanceId === instanceId,
      );
      if (
        !sourcePane ||
        !hasWorkspaceContent(sourcePane, { kind: "pty", slotId: instanceId }) ||
        !slot
      )
        return;
      const newPaneId = crypto.randomUUID();
      const next = splitAndMoveWorkspaceSession(
        treeRef.current,
        paneId,
        instanceId,
        direction,
        crypto.randomUUID(),
        newPaneId,
      );
      contentCoordinatorRef.current.ensureAttached(
        { kind: "pty", slotId: instanceId },
        { kind: "pane", windowLabel: "main", paneId: newPaneId },
      );
      commitTree(next);
      setFocusedPane(newPaneId);
      const state = useAppStore.getState();
      if (
        state.view !== "detail" ||
        state.selectedDirectoryId !== slot.directoryId
      ) {
        state.openDirectory(slot.directoryId);
      }
    },
    [commitTree, setFocusedPane],
  );

  const splitAndMoveFile = useCallback(
    (paneId: string, documentId: string, direction: SplitDirection) => {
      const sourcePane = findWorkspacePane(treeRef.current, paneId);
      if (
        !sourcePane ||
        !hasWorkspaceContent(sourcePane, { kind: "file", documentId })
      )
        return;
      const nextPaneId = crypto.randomUUID();
      const next = splitAndMoveWorkspaceFile(
        treeRef.current,
        paneId,
        documentId,
        direction,
        crypto.randomUUID(),
        nextPaneId,
      );
      contentCoordinatorRef.current.ensureAttached(
        { kind: "file", documentId },
        { kind: "pane", windowLabel: "main", paneId: nextPaneId },
      );
      commitTree(next);
      setFocusedPane(nextPaneId);
    },
    [commitTree, setFocusedPane],
  );

  const moveSession = useCallback(
    (sourcePaneId: string, destinationPaneId: string, instanceId: string) => {
      const sourcePane = findWorkspacePane(treeRef.current, sourcePaneId);
      const destinationPane = findWorkspacePane(
        treeRef.current,
        destinationPaneId,
      );
      const slot = slotsRef.current.find(
        (candidate) => candidate.instanceId === instanceId,
      );
      if (
        !sourcePane ||
        !hasWorkspaceContent(sourcePane, { kind: "pty", slotId: instanceId }) ||
        !destinationPane ||
        !slot
      ) {
        return;
      }
      const next = moveWorkspaceSession(
        treeRef.current,
        sourcePaneId,
        destinationPaneId,
        instanceId,
      );
      contentCoordinatorRef.current.ensureAttached(
        { kind: "pty", slotId: instanceId },
        { kind: "pane", windowLabel: "main", paneId: destinationPaneId },
      );
      commitTree(next);
      setFocusedPane(destinationPaneId);
      const state = useAppStore.getState();
      if (
        state.view !== "detail" ||
        state.selectedDirectoryId !== slot.directoryId
      ) {
        state.openDirectory(slot.directoryId);
      }
    },
    [commitTree, setFocusedPane],
  );

  const moveFile = useCallback(
    (sourcePaneId: string, destinationPaneId: string, documentId: string) => {
      const next = moveWorkspaceFileToPane(
        treeRef.current,
        sourcePaneId,
        destinationPaneId,
        documentId,
      );
      if (next === treeRef.current) return;
      contentCoordinatorRef.current.ensureAttached(
        { kind: "file", documentId },
        { kind: "pane", windowLabel: "main", paneId: destinationPaneId },
      );
      commitTree(next);
      setFocusedPane(destinationPaneId);
    },
    [commitTree, setFocusedPane],
  );

  const isManagedDetachedDrag = useCallback(
    (instanceId: string, windowLabel: string) =>
      detachedByInstanceRef.current.get(instanceId)?.windowLabel ===
      windowLabel,
    [],
  );
  const isManagedDetachedFileDrag = useCallback(
    (documentId: string, windowLabel: string) =>
      detachedFilesRef.current.get(documentId)?.windowLabel === windowLabel,
    [],
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
        detachedByInstanceRef.current.has(instanceId)
      ) {
        throw new Error(t("pty.detachedMoveUnavailable"));
      }
      const currentSession = useAppStore.getState().ptySessionsById[sessionId];
      if (currentSession?.state !== "running") {
        throw new Error(t("pty.detachedMoveNotRunning"));
      }
      const terminal = terminalRefs.current.get(instanceId);
      if (!terminal) throw new Error(t("pty.terminalNotReady"));

      const windowLabel = `${getWorkspaceContentWindowLabelPrefix("pty")}${crypto.randomUUID()}`;
      const sourcePane = listWorkspacePanes(treeRef.current).find((pane) =>
        hasWorkspaceContent(pane, { kind: "pty", slotId: instanceId }),
      );
      if (!sourcePane) throw new Error(t("pty.detachedMoveUnavailable"));
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
      let driverContext: WorkspaceContentHandoffHookContext<"pty"> = {
        content,
        source,
        target,
        transferId: crypto.randomUUID(),
        generation: ownerState.generation,
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
          new Error(t("pty.detachedMoveUnavailable")),
        ).catch(() => undefined);
        throw new Error(t("pty.detachedMoveUnavailable"));
      }
      const detachedRecord = { instanceId, sessionId, windowLabel };
      const title = workspaceSlotTitle(slot, directories ?? []);
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
          registerPendingWorkspaceContentWindow({
            pending: pendingDetachedRef.current,
            key: instanceId,
            timeoutMs: WORKSPACE_CONTENT_WINDOW_HANDOFF_TIMEOUT_MS,
            onTimeout: (pending) => {
              void pending.window.destroy().catch(() => undefined);
              reject(new Error(t("pty.detachedStartTimedOut")));
            },
            record: {
              ...detachedRecord,
              token: handoff.token,
              resolve,
              reject,
              window: child,
              handoffContext: driverContext,
              handoffPayload: prepared.payload,
            },
          });
          void child.once("tauri://error", (event) => {
            const pending = takePendingWorkspaceContentWindow(
              pendingDetachedRef.current,
              instanceId,
              windowLabel,
            );
            if (!pending) return;
            reject(
              new Error(
                event.payload == null
                  ? t("pty.detachedCreateFailed")
                  : String(event.payload),
              ),
            );
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
    [directories, t, terminalRefs],
  );

  const handleDetachedReady = useCallback(
    (payload: DetachedWindowReadyEvent) => {
      const pending = pendingDetachedRef.current.get(payload.instanceId);
      if (!pending || !matchesDetachedWindow(pending, payload)) {
        return;
      }
      const ownership = contentCoordinatorRef.current.completeHandoff(
        { kind: "pty", slotId: payload.instanceId },
        "detachReady",
        pending.token,
      );
      if (ownership?.outcome !== "changed") {
        void rollbackWorkspaceContentHandoff(
          pending.handoffContext,
          pending.handoffPayload,
          new Error(t("pty.detachedStateChanged")),
        ).catch(() => undefined);
        takePendingWorkspaceContentWindow(
          pendingDetachedRef.current,
          payload.instanceId,
          pending.windowLabel,
        );
        pending.reject(new Error(t("pty.detachedStateChanged")));
        void pending.window.destroy().catch(() => undefined);
        return;
      }
      promotePendingWorkspaceContentWindow({
        pending: pendingDetachedRef.current,
        detached: detachedByInstanceRef.current,
        key: payload.instanceId,
        expectedWindowLabel: pending.windowLabel,
        toDetached: () => ({ ...payload, window: pending.window }),
      });
      setDetachedInstanceIds((current) =>
        new Set(current).add(payload.instanceId),
      );
      const nextTree = removeWorkspaceSession(
        treeRef.current,
        payload.instanceId,
      );
      commitTree(nextTree);
      if (!findWorkspacePane(nextTree, focusedPaneIdRef.current)) {
        setFocusedPane(listWorkspacePanes(nextTree)[0].id);
      }
      pending.resolve();
    },
    [commitTree, setFocusedPane, t],
  );

  const handleDetachedFailed = useCallback(
    (payload: DetachedWindowReadyEvent & { message?: string }) => {
      const pending = pendingDetachedRef.current.get(payload.instanceId);
      if (!pending || !matchesDetachedWindow(pending, payload)) return;
      void rollbackWorkspaceContentHandoff(
        pending.handoffContext,
        pending.handoffPayload,
        new Error(payload.message || t("pty.detachedStartFailed")),
      ).catch(() => undefined);
      contentCoordinatorRef.current.failHandoff(
        { kind: "pty", slotId: payload.instanceId },
        "detachFailed",
        pending.token,
      );
      takePendingWorkspaceContentWindow(
        pendingDetachedRef.current,
        payload.instanceId,
        pending.windowLabel,
      );
      pending.reject(
        new Error(payload.message || t("pty.detachedStartFailed")),
      );
      void pending.window.destroy().catch(() => undefined);
    },
    [t],
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
      const knownDetached = detachedByInstanceRef.current.get(
        payload.instanceId,
      );
      if (knownDetached && !matchesDetachedWindow(knownDetached, payload)) {
        fail(t("pty.detachedSessionMissing"));
        return;
      }
      if (
        !knownDetached &&
        !/^terminal-[0-9a-f-]{36}$/i.test(payload.windowLabel)
      ) {
        fail(t("pty.detachedSessionMissing"));
        return;
      }
      let detached = knownDetached;
      if (!detached) {
        try {
          const [windowStatus, detachedWindow] = await Promise.all([
            getPtySessionWindowStatus(payload.sessionId),
            WebviewWindow.getByLabel(payload.windowLabel),
          ]);
          if (windowStatus !== "ownedByAnotherWindow" || !detachedWindow) {
            fail(t("pty.detachedStateChanged"));
            return;
          }
          detached = {
            instanceId: payload.instanceId,
            sessionId: payload.sessionId,
            windowLabel: payload.windowLabel,
            window: detachedWindow,
          };
          detachedByInstanceRef.current.set(payload.instanceId, detached);
          setDetachedInstanceIds((current) =>
            new Set(current).add(payload.instanceId),
          );
        } catch (reason) {
          fail(t("pty.returnFailed", { error: String(reason) }));
          return;
        }
      }
      const returningContent = {
        kind: "pty",
        slotId: payload.instanceId,
      } as const;
      const currentOwnership =
        contentCoordinatorRef.current.get(returningContent);
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
            `recovered:${payload.instanceId}:${payload.windowLabel}`,
          );
        }
      }
      const returning = contentCoordinatorRef.current.beginReturn(
        returningContent,
        payload.token,
        "main",
        payload.targetPaneId,
      );
      if (returning?.outcome !== "changed") {
        fail(t("pty.detachedStateChanged"));
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
        const deadline = Date.now() + 10_000;
        let slot = slotsRef.current.find(
          (candidate) => candidate.instanceId === payload.instanceId,
        );
        let terminal = terminalRefs.current.get(payload.instanceId);
        while (
          (!slot || !terminal || hydrationStatusRef.current !== "ready") &&
          Date.now() < deadline
        ) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
          slot = slotsRef.current.find(
            (candidate) => candidate.instanceId === payload.instanceId,
          );
          terminal = terminalRefs.current.get(payload.instanceId);
        }
        if (!slot || !terminal || hydrationStatusRef.current !== "ready") {
          failPendingReturn(t("pty.workspaceRestoring"));
          return;
        }
        if (slot.sessionId !== payload.sessionId) {
          failPendingReturn(t("pty.detachedSessionMissing"));
          return;
        }
        const currentTree = treeRef.current;
        const targetPane =
          (payload.targetPaneId &&
            findWorkspacePane(currentTree, payload.targetPaneId)) ||
          findWorkspacePane(currentTree, focusedPaneIdRef.current) ||
          listWorkspacePanes(currentTree)[0];
        if (!targetPane) {
          failPendingReturn(t("pty.workspaceRestoring"));
          return;
        }
        const lifecycleState =
          contentCoordinatorRef.current.get(returningContent);
        returnDriverContext = {
          content: returningContent,
          source: { kind: "window", windowLabel: payload.windowLabel },
          target: { kind: "pane", windowLabel: "main", paneId: targetPane.id },
          transferId: payload.token,
          generation: lifecycleState?.generation ?? 0,
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
          throw new Error(t("pty.detachedStateChanged"));
        }
        const existingPane = listWorkspacePanes(currentTree).find((pane) =>
          hasWorkspaceContent(pane, {
            kind: "pty",
            slotId: payload.instanceId,
          }),
        );
        const nextTree = existingPane
          ? activateWorkspaceSession(
              currentTree,
              existingPane.id,
              payload.instanceId,
            )
          : addSessionToWorkspacePane(
              currentTree,
              targetPane.id,
              payload.instanceId,
            );
        commitTree(nextTree);
        setFocusedPane(existingPane?.id ?? targetPane.id);
        detachedByInstanceRef.current.delete(payload.instanceId);
        setDetachedInstanceIds((current) => {
          const next = new Set(current);
          next.delete(payload.instanceId);
          return next;
        });
        useAppStore.getState().openDirectory(slot.directoryId);
        const ownership = contentCoordinatorRef.current.completeHandoff(
          returningContent,
          "returnReady",
          payload.token,
        );
        if (ownership?.outcome !== "changed") {
          throw new Error(t("pty.detachedStateChanged"));
        }
        try {
          await detached.window.destroy();
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
        failPendingReturn(String(reason));
      }
    },
    [commitTree, setFocusedPane, t, terminalRefs],
  );

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void)[] = [];
    void Promise.all([
      listenWorkspaceContentWindowEvent("pty-detached-ready", (event) =>
        handleDetachedReady(event.payload),
      ),
      listenWorkspaceContentWindowEvent("pty-detached-failed", (event) =>
        handleDetachedFailed(event.payload),
      ),
      listenWorkspaceContentWindowEvent("pty-return-requested", (event) => {
        void handlePtyReturnRequest(event.payload);
      }),
      listenWorkspaceContentWindowEvent("pty-detached-exited", (event) => {
        const pending = pendingDetachedRef.current.get(
          event.payload.instanceId,
        );
        if (pending && matchesDetachedWindow(pending, event.payload)) {
          void rollbackWorkspaceContentHandoff(
            pending.handoffContext,
            pending.handoffPayload,
            new Error(t("pty.detachedExitedBeforeReady")),
          ).catch(() => undefined);
          contentCoordinatorRef.current.failHandoff(
            { kind: "pty", slotId: event.payload.instanceId },
            "detachCancelled",
            pending.token,
          );
          takePendingWorkspaceContentWindow(
            pendingDetachedRef.current,
            event.payload.instanceId,
            pending.windowLabel,
          );
          pending.reject(new Error(t("pty.detachedExitedBeforeReady")));
          void pending.window.destroy().catch(() => undefined);
          removeSlot(event.payload.instanceId);
          return;
        }
        const detached = detachedByInstanceRef.current.get(
          event.payload.instanceId,
        );
        if (matchesDetachedWindow(detached, event.payload)) {
          removeSlot(event.payload.instanceId);
        }
      }),
    ]).then((stops) => {
      if (disposed) stops.forEach((stop) => stop());
      else unlisten = stops;
    });
    return () => {
      disposed = true;
      unlisten.forEach((stop) => stop());
    };
  }, [
    handleDetachedFailed,
    handleDetachedReady,
    handlePtyReturnRequest,
    removeSlot,
    t,
  ]);

  useEffect(() => {
    let disposed = false;
    const stops: (() => void)[] = [];
    const setup = async () => {
      const listeners = await Promise.all([
        listenWorkspaceContentWindowEvent(
          "workspace-file-window-ready",
          async (event) => {
            const pending = pendingDetachedFilesRef.current.get(
              event.payload.documentId,
            );
            if (
              !pending ||
              !matchesWorkspaceFileWindow(pending, event.payload)
            ) {
              return;
            }
            const content = {
              kind: "file",
              documentId: pending.documentId,
            } as const;
            const currentState = contentCoordinatorRef.current.get(content);
            const driverContext: WorkspaceContentHandoffHookContext<"file"> = {
              content,
              source: {
                kind: "pane",
                windowLabel: "main",
                paneId:
                  pending.sourcePaneId ??
                  listWorkspacePanes(treeRef.current)[0]?.id ??
                  "unknown-pane",
              },
              target: { kind: "window", windowLabel: pending.windowLabel },
              transferId: pending.token,
              generation: currentState?.generation ?? 0,
              capabilities: {
                prepare: async () => {
                  const document = fileDocumentsRef.current.find(
                    (candidate) => candidate.id === pending.documentId,
                  );
                  const buffer = fileBuffersRef.current[pending.documentId];
                  if (!document || !buffer) {
                    throw new Error(t("workspaceFiles.loadingFile"));
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
              prepared = await prepareWorkspaceContentHandoff(driverContext);
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
                pending.documentId,
                pending.windowLabel,
              );
              pending.reject(new Error(String(reason)));
              void pending.window.destroy().catch(() => undefined);
              return;
            }
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
        listenWorkspaceContentWindowEvent(
          "workspace-file-window-attached",
          (event) => {
            const pending = pendingDetachedFilesRef.current.get(
              event.payload.documentId,
            );
            if (
              !pending ||
              !matchesWorkspaceFileWindow(pending, event.payload)
            ) {
              return;
            }
            const ownership = contentCoordinatorRef.current.completeHandoff(
              { kind: "file", documentId: pending.documentId },
              "detachReady",
              pending.token,
            );
            if (ownership?.outcome !== "changed") {
              if (pending.handoffContext) {
                void rollbackWorkspaceContentHandoff(
                  pending.handoffContext,
                  pending.handoffPayload,
                  new Error(t("pty.detachedStateChanged")),
                ).catch(() => undefined);
              }
              takePendingWorkspaceContentWindow(
                pendingDetachedFilesRef.current,
                pending.documentId,
                pending.windowLabel,
              );
              pending.reject(new Error(t("pty.detachedStateChanged")));
              void pending.window.destroy().catch(() => undefined);
              return;
            }
            pending.attached = true;
            promotePendingWorkspaceContentWindow({
              pending: pendingDetachedFilesRef.current,
              detached: detachedFilesRef.current,
              key: pending.documentId,
              expectedWindowLabel: pending.windowLabel,
              toDetached: (record) => record,
            });
            setDetachedFileIds((current) => {
              const next = new Set(current).add(pending.documentId);
              detachedFileIdsRef.current = next;
              return next;
            });
            const pane = listWorkspacePanes(treeRef.current).find((candidate) =>
              hasWorkspaceContent(candidate, {
                kind: "file",
                documentId: pending.documentId,
              }),
            );
            if (pane) {
              commitTree(
                deactivateWorkspaceFile(
                  treeRef.current,
                  pane.id,
                  pending.documentId,
                ),
              );
            }
            pending.resolve();
          },
        ),
        listenWorkspaceContentWindowEvent(
          "workspace-file-window-attach-failed",
          (event) => {
            const pending = pendingDetachedFilesRef.current.get(
              event.payload.documentId,
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
                  event.payload.message ?? t("pty.detachedStartFailed"),
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
              pending.documentId,
              pending.windowLabel,
            );
            pending.reject(
              new Error(event.payload.message ?? t("pty.detachedStartFailed")),
            );
            void pending.window.destroy().catch(() => undefined);
          },
        ),
        listenWorkspaceContentWindowEvent(
          "workspace-file-window-buffer-changed",
          (event) => {
            const managed = detachedFilesRef.current.get(
              event.payload.documentId,
            );
            if (
              !managed ||
              !matchesWorkspaceFileWindow(managed, event.payload) ||
              !event.payload.fileBuffer
            ) {
              return;
            }
            const owner = contentCoordinatorRef.current.get({
              kind: "file",
              documentId: managed.documentId,
            });
            const currentBuffer = fileBuffersRef.current[managed.documentId];
            if (
              owner?.phase !== "detached" ||
              owner.owner.kind !== "window" ||
              owner.owner.windowLabel !== managed.windowLabel ||
              !isWorkspaceFileBufferNewer(
                event.payload.fileBuffer,
                currentBuffer,
              )
            ) {
              return;
            }
            const next = {
              ...fileBuffersRef.current,
              [managed.documentId]: event.payload.fileBuffer,
            };
            fileBuffersRef.current = next;
            setFileBuffers(next);
          },
        ),
        listenWorkspaceContentWindowEvent(
          "workspace-file-window-return-requested",
          async (event) => {
            let managed = detachedFilesRef.current.get(
              event.payload.documentId,
            );
            if (
              !managed &&
              event.payload.fileDocument &&
              event.payload.fileBuffer &&
              matchesWorkspaceFileWindow(
                {
                  documentId: event.payload.documentId,
                  token: event.payload.token,
                  windowLabel: event.payload.windowLabel,
                },
                event.payload,
              )
            ) {
              const knownDocument = fileDocumentsRef.current.find(
                (document) => document.id === event.payload.documentId,
              );
              const incomingDocument = event.payload.fileDocument;
              if (
                knownDocument &&
                incomingDocument.id === knownDocument.id &&
                knownDocument.directoryId === incomingDocument.directoryId &&
                knownDocument.directoryPath ===
                  incomingDocument.directoryPath &&
                knownDocument.relativePath === incomingDocument.relativePath
              ) {
                const window = await WebviewWindow.getByLabel(
                  event.payload.windowLabel,
                );
                if (window) {
                  managed = {
                    documentId: knownDocument.id,
                    token: event.payload.token,
                    windowLabel: event.payload.windowLabel,
                    window,
                    timer: 0,
                    resolve: () => undefined,
                    reject: () => undefined,
                    attached: true,
                  };
                  detachedFilesRef.current.set(knownDocument.id, managed);
                  setDetachedFileIds((current) => {
                    const next = new Set(current).add(knownDocument.id);
                    detachedFileIdsRef.current = next;
                    return next;
                  });
                }
              }
            }
            if (
              !managed ||
              !matchesWorkspaceFileWindow(managed, event.payload) ||
              !event.payload.fileDocument ||
              !event.payload.fileBuffer
            ) {
              await emitWorkspaceContentWindowEvent(
                event.payload.windowLabel,
                "workspace-file-window-return-failed",
                {
                  documentId: event.payload.documentId,
                  token: event.payload.token,
                  message: t("pty.returnFailed", {
                    error: t("pty.workspaceRestoring"),
                  }),
                },
              ).catch(() => undefined);
              return;
            }
            const content = {
              kind: "file",
              documentId: event.payload.documentId,
            } as const;
            const currentOwnership = contentCoordinatorRef.current.get(content);
            if (
              currentOwnership?.phase === "returning" &&
              currentOwnership.transferId === event.payload.token
            ) {
              return;
            }
            if (currentOwnership?.phase !== "detached") {
              const sourcePane =
                listWorkspacePanes(treeRef.current).find((pane) =>
                  hasWorkspaceContent(pane, content),
                ) ??
                findWorkspacePane(treeRef.current, focusedPaneIdRef.current) ??
                listWorkspacePanes(treeRef.current)[0];
              if (sourcePane) {
                contentCoordinatorRef.current.reconcileDetached(
                  content,
                  {
                    kind: "pane",
                    windowLabel: "main",
                    paneId: sourcePane.id,
                  },
                  { kind: "window", windowLabel: managed.windowLabel },
                  `recovered:${content.documentId}:${managed.windowLabel}`,
                );
              }
            }
            const returning = contentCoordinatorRef.current.beginReturn(
              { kind: "file", documentId: event.payload.documentId },
              event.payload.token,
              "main",
              event.payload.targetPaneId,
            );
            if (returning?.outcome !== "changed") {
              await emitWorkspaceContentWindowEvent(
                event.payload.windowLabel,
                "workspace-file-window-return-failed",
                {
                  documentId: event.payload.documentId,
                  token: event.payload.token,
                  message: t("pty.returnFailed", {
                    error: t("pty.detachedStateChanged"),
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
              const document = event.payload.fileDocument;
              const incomingBuffer = event.payload.fileBuffer;
              const currentBuffer = fileBuffersRef.current[document.id];
              const returnedBuffer =
                currentBuffer &&
                isWorkspaceFileBufferNewer(currentBuffer, incomingBuffer)
                  ? currentBuffer
                  : incomingBuffer;
              let targetPane = event.payload.targetPaneId
                ? findWorkspacePane(treeRef.current, event.payload.targetPaneId)
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
              if (!targetPane) throw new Error(t("pty.workspaceRestoring"));
              const currentState = contentCoordinatorRef.current.get(content);
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
                generation: currentState?.generation ?? 0,
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
              const activeReturn = contentCoordinatorRef.current.get(content);
              if (
                activeReturn?.phase !== "returning" ||
                activeReturn.transferId !== event.payload.token
              ) {
                throw new Error(t("pty.detachedStateChanged"));
              }
              const nextTree = hasWorkspaceContent(targetPane, {
                kind: "file",
                documentId: document.id,
              })
                ? activateWorkspaceFile(
                    treeRef.current,
                    targetPane.id,
                    document.id,
                  )
                : addWorkspaceFileToPane(
                    treeRef.current,
                    targetPane.id,
                    document.id,
                  );
              commitTree(nextTree);
              setFocusedPane(targetPane.id);
              const ownership = contentCoordinatorRef.current.completeHandoff(
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
                    message: t("pty.returnFailed", {
                      error: t("pty.detachedStateChanged"),
                    }),
                  },
                ).catch(() => undefined);
                return;
              }
              detachedFilesRef.current.delete(document.id);
              setDetachedFileIds((current) => {
                const next = new Set(current);
                next.delete(document.id);
                detachedFileIdsRef.current = next;
                return next;
              });
              await emitWorkspaceContentWindowEvent(
                event.payload.windowLabel,
                "workspace-file-window-return-complete",
                {
                  documentId: document.id,
                  token: event.payload.token,
                },
              ).catch(() => managed.window.destroy().catch(() => undefined));
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
                  message: t("pty.returnFailed", { error: String(reason) }),
                },
              ).catch(() => undefined);
            }
          },
        ),
      ]);
      if (disposed) listeners.forEach((stop) => stop());
      else stops.push(...listeners);
    };
    void setup().catch((reason) =>
      console.error("File window listener setup failed", reason),
    );
    return () => {
      disposed = true;
      stops.forEach((stop) => stop());
    };
  }, [commitTree, setFocusedPane, t]);

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
        const activeSlotId =
          activeContent?.kind === "pty" ? activeContent.slotId : null;
        const activeSlot = slotsRef.current.find(
          (slot) => slot.instanceId === activeSlotId,
        );
        if (activeSlot) {
          useAppStore.getState().openDirectory(activeSlot.directoryId);
        }
      }
    },
    [commitTree, setFocusedPane],
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
    for (const instanceId of detachedInstanceIdsRef.current) {
      presetTree = removeWorkspaceSession(presetTree, instanceId);
    }
    const presetPanes = listWorkspacePanes(presetTree);
    const paneSlotIds = new Set(
      presetPanes.flatMap((pane) =>
        listWorkspacePaneContents(pane, "pty").flatMap((content) =>
          content.kind === "pty" ? [content.slotId] : [],
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
      documents: fileDocumentsRef.current,
      detachedSlotIds: [],
    });
  }, [directories]);

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
      editFile,
      saveFile,
      closeFile,
      closeFiles,
      closePtySlots,
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
      editFile,
      saveFile,
      closeFile,
      closeFiles,
      closePtySlots,
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
    ],
  );

  return (
    <PtyWorkspaceContext.Provider value={value}>
      {children}
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
    detachSession,
    detachFile,
    closeEmptyPane,
    updateSplitRatio,
    retryHydration,
    resetWorkspace,
    activateFile,
    closeFile,
    closeFiles,
    closePtySlots,
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

  const closeSlot = (slot: PtyWorkspaceSlot) => closePtySlots([slot]);
  const closeSlots = closePtySlots;

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
                toast.error(String(reason)),
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
          onCloseFile={closeFile}
          onCloseFiles={closeFiles}
          onDetachFile={(documentId) => {
            void detachFile(documentId).catch((reason) =>
              toast.error(String(reason)),
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
              toast.error(String(reason)),
            );
          }}
          onCloseEmptyPane={closeEmptyPane}
          onSplitResize={updateSplitRatio}
          onCloseSlot={closeSlot}
          onCloseSlots={closeSlots}
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
      toast.error(t("pty.layoutActionFailed", { error: String(reason) }));
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
        toast.error(t("pty.layoutActionFailed", { error: String(reason) }));
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
  onCloseFile: (documentId: string, skipDirtyConfirmation?: boolean) => void;
  onCloseFiles: (
    documentIds: string[],
    skipDirtyConfirmation?: boolean,
  ) => void;
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
  onCloseSlot: (slot: PtyWorkspaceSlot) => void;
  onCloseSlots: (slots: PtyWorkspaceSlot[], skipConfirmation?: boolean) => void;
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
  onCloseFile,
  onCloseFiles,
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
  onCloseSlot,
  onCloseSlots,
}: WorkspaceTreeViewProps & {
  pane: Extract<WorkspaceNode, { kind: "pane" }>;
}) {
  const { t } = useTranslation();
  const paneName = t("pty.paneNumber", { number: pane.paneNumber });
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
  const paneFiles = listWorkspacePaneContents(pane, "file")
    .map((content) => (content.kind === "file" ? content.documentId : null))
    .filter((documentId): documentId is string => documentId !== null)
    .filter((documentId) => !detachedFileIds.has(documentId))
    .map((documentId) =>
      fileDocuments.find((document) => document.id === documentId),
    )
    .filter((document): document is WorkspaceFileDocument => Boolean(document));
  const paneContentEntries: ResolvedPaneContent[] = pane.contents.flatMap(
    (content): ResolvedPaneContent[] => {
      if (content.kind === "pty") {
        const slot = slots.find(
          (candidate) => candidate.instanceId === content.slotId,
        );
        return slot ? [{ content, slot }] : [];
      }
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
  const previousContents = contentSequence.before;
  const nextContents = contentSequence.after;
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
        toast.error(String(reason)),
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

  const renderActiveTab = (slot: PtyWorkspaceSlot) => {
    const tool = TOOLS.find((entry) => entry.key === slot.toolKey)!;
    const ToolIcon = tool.icon;
    const session =
      !slot.restoredState && slot.sessionId
        ? ptySessionsById[slot.sessionId]
        : undefined;
    const title = workspaceSlotTitle(slot, directories);

    return (
      <WorkspaceContentTab
        key={slot.instanceId}
        title={title}
        active={
          pane.activeContent?.kind !== "file" &&
          pane.activeContent?.kind === "pty" &&
          pane.activeContent.slotId === slot.instanceId
        }
        related={slot.directoryId === selectedDirectoryId}
        closeLabel={t(
          getWorkspaceContentAdapter("pty").presentation.labels.close,
        )}
        closeAccessibleName={t("pty.closeNamed", { name: title })}
        draggable
        onDragStart={(event) =>
          beginWorkspaceSessionDrag(event, pane.id, slot.instanceId)
        }
        onActivate={() => onActivateSession(pane.id, slot.instanceId)}
        onRequestClose={() => void onCloseSlot(slot)}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onFocusPane(pane.id);
          setContextMenu({
            target: { kind: "pty", instanceId: slot.instanceId },
            x: event.clientX,
            y: event.clientY,
          });
        }}
      >
        <ToolIcon size={13} />
        <span
          className={clsx("pty-pane-tab-status", {
            running: session?.state === "running",
            failed:
              session?.state === "failed" ||
              isInvalidRestoredSlotState(slot.restoredState),
          })}
          aria-hidden="true"
        />
        <span className="pty-pane-tab-title">{title}</span>
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
            toast.error(t("pty.returnFailed", { error: String(reason) })),
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
          ).catch((reason) => toast.error(String(reason)));
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
            toast.error(t("pty.returnFailed", { error: String(reason) })),
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
        <div className="pty-pane-tabs">
          {previousContents.length > 0 && (
            <PaneSessionStack
              side="before"
              sourcePaneId={pane.id}
              entries={previousContents}
              directories={directories}
              ptySessionsById={ptySessionsById}
              onActivate={(entry) => {
                if (entry.content.kind === "pty")
                  onActivateSession(pane.id, entry.content.slotId);
                else onActivateFile(pane.id, entry.content.documentId);
              }}
              onCloseContent={(entry) => {
                if ("slot" in entry) onCloseSlot(entry.slot);
                else onCloseFile(entry.file.id);
              }}
              onContextMenu={(entry, x, y) => {
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
          {activeSlot && (
            <div
              className="pty-pane-active-tablist"
              role="tablist"
              aria-label={t("pty.paneSessions")}
            >
              {renderActiveTab(activeSlot)}
            </div>
          )}
          {paneFiles
            .filter((file) => file.id === activeFileId)
            .map((file) => {
              const buffer = fileBuffers[file.id];
              const fileName = file.relativePath.split("/").pop();
              const dirty = buffer && buffer.content !== buffer.savedContent;
              return (
                <WorkspaceContentTab
                  className="file-tab-group"
                  key={file.id}
                  title={file.relativePath}
                  active={activeFileId === file.id}
                  closeLabel={t(
                    getWorkspaceContentAdapter("file").presentation.labels
                      .close,
                  )}
                  closeAccessibleName={t("workspaceFiles.closeFileNamed", {
                    name: file.relativePath,
                  })}
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "move";
                    const payload = encodeWorkspaceContentDrag({
                      kind: "file",
                      contentId: file.id,
                      sourcePaneId: pane.id,
                      sourceWindowLabel: "main",
                    });
                    event.dataTransfer.setData(
                      WORKSPACE_CONTENT_DRAG_TYPE,
                      payload,
                    );
                    event.dataTransfer.setData("text/plain", payload);
                  }}
                  onActivate={() => onActivateFile(pane.id, file.id)}
                  onRequestClose={() => onCloseFile(file.id)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onFocusPane(pane.id);
                    onActivateFile(pane.id, file.id);
                    setContextMenu({
                      target: { kind: "file", documentId: file.id },
                      x: event.clientX,
                      y: event.clientY,
                    });
                  }}
                >
                  <span className="pty-pane-tab-title">
                    {fileName}
                    {dirty ? " •" : ""}
                  </span>
                </WorkspaceContentTab>
              );
            })}
          {nextContents.length > 0 && (
            <PaneSessionStack
              side="after"
              sourcePaneId={pane.id}
              entries={nextContents}
              directories={directories}
              ptySessionsById={ptySessionsById}
              onActivate={(entry) => {
                if (entry.content.kind === "pty")
                  onActivateSession(pane.id, entry.content.slotId);
                else onActivateFile(pane.id, entry.content.documentId);
              }}
              onCloseContent={(entry) => {
                if ("slot" in entry) onCloseSlot(entry.slot);
                else onCloseFile(entry.file.id);
              }}
              onContextMenu={(entry, x, y) => {
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
        />
        {paneSlots.length === 0 && !activeFile && (
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
          const itemTitle = targetSlot
            ? workspaceSlotTitle(targetSlot, directories)
            : (targetFile?.relativePath ?? "");
          const adapter = getWorkspaceContentAdapter(target.kind);
          const labels = {
            menu: t(adapter.presentation.labels.menu),
            closeCurrent: (name: string) =>
              t(adapter.presentation.labels.closeCurrent, { name }),
            closeOthers: (count: number) =>
              t(adapter.presentation.labels.closeOthers, { count }),
            closeAll: (count: number) =>
              t(adapter.presentation.labels.closeAll, { count }),
            splitAndMoveRight: t(adapter.presentation.labels.splitAndMoveRight),
            splitAndMoveDown: t(adapter.presentation.labels.splitAndMoveDown),
          };
          const closeContents = (
            contents: WorkspacePaneContentRef[],
            afterConfirm?: () => void,
          ) => {
            setContextMenu(null);
            const ptySlots = contents
              .filter(
                (
                  content,
                ): content is Extract<
                  WorkspacePaneContentRef,
                  { kind: "pty" }
                > => content.kind === "pty",
              )
              .map((content) =>
                slots.find((slot) => slot.instanceId === content.slotId),
              )
              .filter((slot): slot is PtyWorkspaceSlot => Boolean(slot));
            const fileIds = contents
              .filter(
                (
                  content,
                ): content is Extract<
                  WorkspacePaneContentRef,
                  { kind: "file" }
                > => content.kind === "file",
              )
              .map((content) => content.documentId);
            const hasDirtyFiles = fileIds.some((documentId) => {
              const buffer = fileBuffers[documentId];
              return Boolean(buffer && buffer.content !== buffer.savedContent);
            });
            if (
              hasDirtyFiles &&
              !window.confirm(t("workspaceFiles.discardChanges"))
            ) {
              return;
            }
            const runningPtyCount = ptySlots.filter(
              (slot) =>
                !slot.restoredState &&
                slot.sessionId &&
                ptySessionsById[slot.sessionId]?.state === "running",
            ).length;
            if (
              runningPtyCount > 0 &&
              !window.confirm(
                t("pty.confirmCloseMany", { count: runningPtyCount }),
              )
            ) {
              return;
            }
            afterConfirm?.();
            if (ptySlots.length > 0) void onCloseSlots(ptySlots, true);
            if (fileIds.length > 0) onCloseFiles(fileIds, true);
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
                    slots,
                    directories,
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
              onCloseCurrent={() => closeContents([targetContent])}
              onCloseOthers={() =>
                closeContents(otherContents, () => {
                  if (targetSlot)
                    onActivateSession(pane.id, targetSlot.instanceId);
                  if (targetFile) onActivateFile(pane.id, targetFile.id);
                })
              }
              onCloseAll={() => closeContents(paneContentRefs)}
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
  ptySessionsById,
  onActivate,
  onCloseContent,
  onContextMenu,
}: {
  side: "before" | "after";
  sourcePaneId: string;
  entries: ResolvedPaneContent[];
  directories: { id: number; name: string }[];
  ptySessionsById: Record<string, PtySession>;
  onActivate: (entry: ResolvedPaneContent) => void;
  onCloseContent: (entry: ResolvedPaneContent) => void;
  onContextMenu: (entry: ResolvedPaneContent, x: number, y: number) => void;
}) {
  const { t } = useTranslation();
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const label = t(
    side === "before" ? "pty.previousSessions" : "pty.nextSessions",
    { count: entries.length },
  );
  const heading = t(
    side === "before"
      ? "pty.previousSessionsHeading"
      : "pty.nextSessionsHeading",
  );

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
          <div className="pty-pane-session-stack-list" aria-label={heading}>
            {entries.map((entry) => {
              const slot = "slot" in entry ? entry.slot : undefined;
              const file = "file" in entry ? entry.file : undefined;
              const tool = slot
                ? TOOLS.find((candidate) => candidate.key === slot.toolKey)
                : undefined;
              const ToolIcon = tool?.icon;
              const session = slot
                ? !slot.restoredState && slot.sessionId
                  ? ptySessionsById[slot.sessionId]
                  : undefined
                : undefined;
              const title = slot
                ? workspaceSlotTitle(slot, directories)
                : (file?.relativePath ?? "");
              const contentKey =
                entry.content.kind === "pty"
                  ? `pty:${entry.content.slotId}`
                  : `file:${entry.content.documentId}`;
              const closeLabel = t(
                getWorkspaceContentAdapter(entry.content.kind).presentation
                  .labels.close,
              );
              const closeAccessibleName = t(
                getWorkspaceContentAdapter(entry.content.kind).presentation
                  .labels.closeCurrent,
                { name: title },
              );

              return (
                <div
                  className="pty-pane-session-stack-entry"
                  key={contentKey}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setOpen(false);
                    onContextMenu(entry, event.clientX, event.clientY);
                  }}
                >
                  <button
                    type="button"
                    className="pty-pane-session-stack-session"
                    title={title}
                    aria-label={title}
                    draggable
                    onDragStart={(event) => {
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
                    {ToolIcon ? <ToolIcon size={14} /> : <FileText size={14} />}
                    {slot && (
                      <span
                        className={clsx("pty-pane-tab-status", {
                          running: session?.state === "running",
                          failed:
                            session?.state === "failed" ||
                            isInvalidRestoredSlotState(slot.restoredState),
                        })}
                        aria-hidden="true"
                      />
                    )}
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

function workspacePaneTitle(
  pane: WorkspacePane,
  slots: PtyWorkspaceSlot[],
  directories: { id: number; name: string }[],
  paneName: string,
  emptyPaneLabel: string,
): string {
  const activeContent = pane.activeContent;
  const activeSlot =
    activeContent?.kind === "pty"
      ? slots.find((slot) => slot.instanceId === activeContent.slotId)
      : undefined;
  const targetTitle = activeSlot
    ? workspaceSlotTitle(activeSlot, directories)
    : emptyPaneLabel;
  return `${paneName} · ${targetTitle}`;
}

function workspaceSlotTitle(
  slot: PtyWorkspaceSlot,
  directories: { id: number; name: string }[],
): string {
  if (slot.title.kind === "custom") return slot.title.value;
  const directory = directories.find((entry) => entry.id === slot.directoryId);
  const toolLabel = getTerminalTitleLabel(slot.toolKey);
  const projectName = directory?.name ?? slot.projectName;
  return (
    (projectName || toolLabel) +
    "-" +
    toolLabel +
    "-" +
    String(slot.sequence).padStart(2, "0")
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

function isInvalidRestoredSlotState(
  state: WorkspaceSlotStateKind | undefined,
): boolean {
  return (
    state === "missingProject" ||
    state === "projectIdentityMismatch" ||
    state === "missingSession" ||
    state === "sessionIdentityMismatch"
  );
}

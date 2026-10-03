import clsx from "clsx";
import { Allotment, type AllotmentHandle } from "allotment";
import { emitTo, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import {
  ChevronDown,
  ChevronRight,
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
  type MutableRefObject,
  type ReactNode,
  type DragEvent as ReactDragEvent,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useDirectories } from "../hooks/queries";
import { getWindowChromeOptions } from "../lib/windowChrome";
import {
  type WorkspaceNode,
  activateWorkspaceSession,
  addSessionToWorkspacePane,
  canSplitWorkspacePane,
  createWorkspacePane,
  findWorkspacePane,
  listWorkspacePanes,
  moveWorkspaceSession,
  MIN_WORKSPACE_PANE_HEIGHT,
  MIN_WORKSPACE_PANE_WIDTH,
  minimumWorkspacePaneExtent,
  isUsableWorkspaceSplitSizes,
  nextWorkspaceSessionSequence,
  removeEmptyWorkspacePane,
  removeWorkspaceSession,
  setWorkspaceSplitRatio,
  splitAndMoveWorkspaceSession,
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
import { matchesDetachedWindow } from "../lib/ptySessionLifecycle";
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
  type Directory,
  type PtySession,
  type ToolKey,
  type WorkspaceLayoutDocument,
  type WorkspaceLayoutSlot,
  type WorkspaceLayoutPresetSummary,
  type WorkspaceSlotStateKind,
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
import { useAppStore } from "../store/appStore";
import { AnchoredPopover } from "./AnchoredPopover";
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
}

interface DetachedWindowReadyEvent extends DetachedWindowRecord {}

interface PtyReturnRequestEvent extends DetachedWindowRecord {
  token: string;
  targetPaneId?: string;
}

interface PtyWorkspaceContextValue {
  slots: PtyWorkspaceSlot[];
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
  focusPane: (paneId: string) => void;
  activateSession: (paneId: string, instanceId: string) => void;
  splitPane: (paneId: string, direction: SplitDirection) => void;
  splitAndMoveSession: (
    paneId: string,
    instanceId: string,
    direction: SplitDirection,
  ) => void;
  moveSession: (
    sourcePaneId: string,
    destinationPaneId: string,
    instanceId: string,
  ) => void;
  detachedInstanceIds: Set<string>;
  hasDetachedSessions: boolean;
  isManagedDetachedDrag: (instanceId: string, windowLabel: string) => boolean;
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
  removeSlot: (instanceId: string) => void;
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
  const treeRef = useRef(tree);
  const focusedPaneIdRef = useRef(focusedPaneId);
  const detachedByInstanceRef = useRef(
    new Map<string, ManagedDetachedWindow>(),
  );
  const pendingDetachedRef = useRef(new Map<string, PendingDetachedWindow>());
  const upsertPtySession = useAppStore((state) => state.upsertPtySession);
  const removePtySession = useAppStore((state) => state.removePtySession);
  const activeView = useAppStore((state) => state.view);

  slotsRef.current = slots;
  if (!splitResizeInProgressRef.current) treeRef.current = tree;
  focusedPaneIdRef.current = focusedPaneId;
  detachedInstanceIdsRef.current = detachedInstanceIds;
  hydrationStatusRef.current = hydrationStatus;

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
          detachedSlotIds: [...detachedInstanceIdsRef.current].filter(
            (instanceId) =>
              !listWorkspacePanes(treeOverride ?? treeRef.current).some(
                (pane) => pane.sessionIds.includes(instanceId),
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

        slotsRef.current = restoredSlots;
        treeRef.current = restoredSnapshot.tree;
        focusedPaneIdRef.current = restoredSnapshot.focusedPaneId;
        setSlots(restoredSlots);
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
  }, [createSaveQueue]);

  useEffect(() => {
    void hydrateWorkspace();
    return () => {
      hydrationRequestRef.current += 1;
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

      slotsRef.current = restoredSlots;
      treeRef.current = restored.tree;
      focusedPaneIdRef.current = restored.focusedPaneId;
      setSlots(restoredSlots);
      setTree(restored.tree);
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
        (slot) => slot.instanceId === pane.activeSessionId,
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
    (instanceId: string) => {
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
        (slot) => slot.instanceId === sourcePane.activeSessionId,
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
      if (!sourcePane?.sessionIds.includes(instanceId) || !slot) return;
      const newPaneId = crypto.randomUUID();
      const next = splitAndMoveWorkspaceSession(
        treeRef.current,
        paneId,
        instanceId,
        direction,
        crypto.randomUUID(),
        newPaneId,
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
        !sourcePane?.sessionIds.includes(instanceId) ||
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

  const isManagedDetachedDrag = useCallback(
    (instanceId: string, windowLabel: string) =>
      detachedByInstanceRef.current.get(instanceId)?.windowLabel ===
      windowLabel,
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

      const handoff = await terminal.captureHandoff();
      const windowLabel = `terminal-${crypto.randomUUID()}`;
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

      try {
        await new Promise<void>((resolve, reject) => {
          const { trafficLightPosition, ...chromeOptions } =
            getWindowChromeOptions(navigator.userAgent);
          const child = new WebviewWindow(windowLabel, {
            ...chromeOptions,
            ...(trafficLightPosition
              ? {
                  trafficLightPosition: new LogicalPosition(
                    trafficLightPosition.x,
                    trafficLightPosition.y,
                  ),
                }
              : {}),
            url: `${childUrl.pathname}${childUrl.search}${childUrl.hash}`,
            title,
            width: 1100,
            height: 760,
            minWidth: 560,
            minHeight: 360,
            dragDropEnabled: false,
          });
          const timer = window.setTimeout(() => {
            const pending = pendingDetachedRef.current.get(instanceId);
            pendingDetachedRef.current.delete(instanceId);
            void pending?.window.destroy().catch(() => undefined);
            reject(new Error(t("pty.detachedStartTimedOut")));
          }, 15_000);
          pendingDetachedRef.current.set(instanceId, {
            ...detachedRecord,
            token: handoff.token,
            resolve,
            reject,
            timer,
            window: child,
          });
          void child.once("tauri://error", (event) => {
            const pending = pendingDetachedRef.current.get(instanceId);
            if (pending?.windowLabel !== windowLabel) return;
            pendingDetachedRef.current.delete(instanceId);
            window.clearTimeout(pending.timer);
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
        await terminal.cancelHandoff(handoff.token).catch(() => undefined);
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
      window.clearTimeout(pending.timer);
      pendingDetachedRef.current.delete(payload.instanceId);
      detachedByInstanceRef.current.set(payload.instanceId, {
        ...payload,
        window: pending.window,
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
    [commitTree, setFocusedPane],
  );

  const handleDetachedFailed = useCallback(
    (payload: DetachedWindowReadyEvent & { message?: string }) => {
      const pending = pendingDetachedRef.current.get(payload.instanceId);
      if (!pending || !matchesDetachedWindow(pending, payload)) return;
      pendingDetachedRef.current.delete(payload.instanceId);
      window.clearTimeout(pending.timer);
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
        void emitTo(payload.windowLabel, "pty-return-failed", {
          instanceId: payload.instanceId,
          token: payload.token,
          message,
        }).catch(() => undefined);
      const knownDetached = detachedByInstanceRef.current.get(
        payload.instanceId,
      );
      if (knownDetached && !matchesDetachedWindow(knownDetached, payload)) {
        fail(t("pty.detachedSessionMissing"));
        return;
      }
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
          fail(t("pty.workspaceRestoring"));
          return;
        }
        if (slot.sessionId !== payload.sessionId) {
          fail(t("pty.detachedSessionMissing"));
          return;
        }
        let detached = detachedByInstanceRef.current.get(payload.instanceId);
        if (!detached) {
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
        }
        await terminal.attachHandoff(payload.sessionId, payload.token);
        const currentTree = treeRef.current;
        const targetPane =
          (payload.targetPaneId &&
            findWorkspacePane(currentTree, payload.targetPaneId)) ||
          findWorkspacePane(currentTree, focusedPaneIdRef.current) ||
          listWorkspacePanes(currentTree)[0];
        const existingPane = listWorkspacePanes(currentTree).find((pane) =>
          pane.sessionIds.includes(payload.instanceId),
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
        try {
          await detached.window.destroy();
        } catch (reason) {
          console.warn("Failed to destroy returned PTY window", reason);
          await emitTo(payload.windowLabel, "pty-return-complete", {
            instanceId: payload.instanceId,
            token: payload.token,
          }).catch(() => undefined);
        }
      } catch (reason) {
        fail(String(reason));
      }
    },
    [commitTree, setFocusedPane, t, terminalRefs],
  );

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void)[] = [];
    void Promise.all([
      listen<DetachedWindowReadyEvent>("pty-detached-ready", (event) =>
        handleDetachedReady(event.payload),
      ),
      listen<DetachedWindowReadyEvent & { message?: string }>(
        "pty-detached-failed",
        (event) => handleDetachedFailed(event.payload),
      ),
      listen<PtyReturnRequestEvent>("pty-return-requested", (event) => {
        void handlePtyReturnRequest(event.payload);
      }),
      listen<DetachedWindowReadyEvent>("pty-detached-exited", (event) => {
        const pending = pendingDetachedRef.current.get(
          event.payload.instanceId,
        );
        if (pending && matchesDetachedWindow(pending, event.payload)) {
          pendingDetachedRef.current.delete(event.payload.instanceId);
          window.clearTimeout(pending.timer);
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

  const closeEmptyPane = useCallback(
    (paneId: string) => {
      const pane = findWorkspacePane(treeRef.current, paneId);
      if (!pane || pane.sessionIds.length > 0) return;
      const next = removeEmptyWorkspacePane(treeRef.current, paneId);
      commitTree(next);
      // Closing a pane changes the split topology. Remount the complete tree
      // so every Allotment recalculates from the surviving tree dimensions,
      // rather than retaining any cached sizes from the previous topology.
      setWorkspaceTreeRevision((revision) => revision + 1);
      if (!findWorkspacePane(next, focusedPaneIdRef.current)) {
        const fallbackPaneId = listWorkspacePanes(next)[0].id;
        setFocusedPane(fallbackPaneId);
        const activeSlotId = findWorkspacePane(
          next,
          fallbackPaneId,
        )?.activeSessionId;
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
    const paneSlotIds = new Set(presetPanes.flatMap((pane) => pane.sessionIds));
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
      detachedSlotIds: [],
    });
  }, [directories]);

  const value = useMemo(
    () => ({
      slots,
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
      focusPane,
      activateSession,
      splitPane,
      splitAndMoveSession,
      moveSession,
      detachedInstanceIds,
      hasDetachedSessions: detachedInstanceIds.size > 0,
      isManagedDetachedDrag,
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
      focusPane,
      activateSession,
      splitPane,
      splitAndMoveSession,
      moveSession,
      detachedInstanceIds,
      isManagedDetachedDrag,
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
    focusPane,
    activateSession,
    splitPane,
    splitAndMoveSession,
    moveSession,
    hasDetachedSessions,
    isManagedDetachedDrag,
    detachSession,
    closeEmptyPane,
    updateSplitRatio,
    retryHydration,
    resetWorkspace,
    removeSlot,
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

  const closeSlot = async (slot: PtyWorkspaceSlot) => {
    if (slot.restoredState) {
      removeSlot(slot.instanceId);
      return;
    }
    const terminal = terminalRefs.current.get(slot.instanceId);
    if (!terminal) return;
    const result = await terminal.closeSession();
    if (result === "closed") removeSlot(slot.instanceId);
  };

  const closeSlots = async (targetSlots: PtyWorkspaceSlot[]) => {
    if (targetSlots.length === 0) return;
    const runningCount = targetSlots.filter(
      (slot) =>
        !slot.restoredState &&
        slot.sessionId &&
        ptySessionsById[slot.sessionId]?.state === "running",
    ).length;
    if (
      runningCount > 0 &&
      !window.confirm(t("pty.confirmCloseMany", { count: runningCount }))
    ) {
      return;
    }

    const results = await Promise.all(
      targetSlots.map(async (slot) => {
        if (slot.restoredState) return { slot, result: "closed" as const };
        const terminal = terminalRefs.current.get(slot.instanceId);
        if (!terminal) return null;
        return { slot, result: await terminal.closeSession(false) };
      }),
    );
    for (const outcome of results) {
      if (outcome?.result === "closed") removeSlot(outcome.slot.instanceId);
    }
    const pendingCount = results.filter(
      (outcome) => outcome?.result === "pending",
    ).length;
    const failedCount = results.filter(
      (outcome) => outcome?.result === "cancelled",
    ).length;
    if (pendingCount > 0) {
      toast.info(t("pty.closePending", { count: pendingCount }));
    }
    if (failedCount > 0) {
      toast.error(t("pty.closeFailedMany", { count: failedCount }));
    }
  };

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
          focusedPaneId={focusedPaneId}
          portalTargets={portalTargets}
          canCloseEmptyPane={listWorkspacePanes(tree).length > 1}
          selectedDirectoryId={selectedDirectoryId}
          directories={directories ?? []}
          ptySessionsById={ptySessionsById}
          workspacePanes={workspacePanes}
          onFocusPane={focusPane}
          onActivateSession={activateSession}
          onSplitPane={splitPane}
          onSplitAndMoveSession={splitAndMoveSession}
          onMoveSession={moveSession}
          hasDetachedSessions={hasDetachedSessions}
          isManagedDetachedDrag={isManagedDetachedDrag}
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
  focusedPaneId: string;
  portalTargets: Record<string, HTMLDivElement>;
  canCloseEmptyPane: boolean;
  selectedDirectoryId: number | null;
  directories: { id: number; name: string }[];
  ptySessionsById: Record<string, PtySession>;
  workspacePanes: WorkspacePane[];
  onFocusPane: (paneId: string) => void;
  onActivateSession: (paneId: string, instanceId: string) => void;
  onSplitPane: (paneId: string, direction: SplitDirection) => void;
  onSplitAndMoveSession: (
    paneId: string,
    instanceId: string,
    direction: SplitDirection,
  ) => void;
  onMoveSession: (
    sourcePaneId: string,
    destinationPaneId: string,
    instanceId: string,
  ) => void;
  hasDetachedSessions: boolean;
  isManagedDetachedDrag: (instanceId: string, windowLabel: string) => boolean;
  onDetachSession: (instanceId: string) => void;
  onCloseEmptyPane: (paneId: string) => void;
  onSplitResize: (
    splitId: string,
    sizes: number[],
    phase: SplitResizePhase,
  ) => void;
  onCloseSlot: (slot: PtyWorkspaceSlot) => void;
  onCloseSlots: (slots: PtyWorkspaceSlot[]) => void;
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
  focusedPaneId,
  portalTargets,
  canCloseEmptyPane,
  selectedDirectoryId,
  directories,
  ptySessionsById,
  workspacePanes,
  onFocusPane,
  onActivateSession,
  onSplitPane,
  onSplitAndMoveSession,
  onMoveSession,
  hasDetachedSessions,
  isManagedDetachedDrag,
  onDetachSession,
  onCloseEmptyPane,
  onCloseSlot,
  onCloseSlots,
}: WorkspaceTreeViewProps & {
  pane: Extract<WorkspaceNode, { kind: "pane" }>;
}) {
  const { t } = useTranslation();
  const paneName = t("pty.paneNumber", { number: pane.paneNumber });
  const paneSlots = pane.sessionIds
    .map((instanceId) => slots.find((slot) => slot.instanceId === instanceId))
    .filter((slot): slot is PtyWorkspaceSlot => Boolean(slot));
  const activeSlotIndex = paneSlots.findIndex(
    (slot) => slot.instanceId === pane.activeSessionId,
  );
  const activeSlot =
    activeSlotIndex >= 0 ? paneSlots[activeSlotIndex] : undefined;
  const previousSlots =
    activeSlotIndex > 0 ? paneSlots.slice(0, activeSlotIndex) : [];
  const nextSlots =
    activeSlotIndex >= 0 ? paneSlots.slice(activeSlotIndex + 1) : [];
  const related = paneSlots.some(
    (slot) => slot.directoryId === selectedDirectoryId,
  );
  const focused = pane.id === focusedPaneId;
  const contentRef = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<{
    instanceId: string;
    x: number;
    y: number;
  } | null>(null);
  const [dropActive, setDropActive] = useState(false);

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

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    for (const slot of paneSlots) {
      const target = portalTargets[slot.instanceId];
      if (!target) continue;
      target.hidden = pane.activeSessionId !== slot.instanceId;
      if (target.parentElement !== content) content.appendChild(target);
    }
  }, [pane.activeSessionId, paneSlots, portalTargets]);

  const renderActiveTab = (slot: PtyWorkspaceSlot) => {
    const tool = TOOLS.find((entry) => entry.key === slot.toolKey)!;
    const ToolIcon = tool.icon;
    const session =
      !slot.restoredState && slot.sessionId
        ? ptySessionsById[slot.sessionId]
        : undefined;
    const title = workspaceSlotTitle(slot, directories);

    return (
      <div
        className="pty-pane-tab-group active"
        key={slot.instanceId}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onFocusPane(pane.id);
          setContextMenu({
            instanceId: slot.instanceId,
            x: event.clientX,
            y: event.clientY,
          });
        }}
      >
        <button
          type="button"
          role="tab"
          className={clsx("pty-pane-tab", {
            active: pane.activeSessionId === slot.instanceId,
            related: slot.directoryId === selectedDirectoryId,
          })}
          title={title}
          draggable
          aria-selected={pane.activeSessionId === slot.instanceId}
          onDragStart={(event) =>
            beginWorkspaceSessionDrag(event, pane.id, slot.instanceId)
          }
          onClick={(event) => {
            event.stopPropagation();
            onActivateSession(pane.id, slot.instanceId);
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
        </button>
        <button
          type="button"
          className="pty-pane-tab-close"
          title={t("pty.close")}
          aria-label={t("pty.closeNamed", { name: title })}
          onClick={(event) => {
            event.stopPropagation();
            void onCloseSlot(slot);
          }}
        >
          <X size={12} />
        </button>
      </div>
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
          !(hasDetachedSessions && types.includes("text/plain"))
        ) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        setDropActive(false);
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
          void emitTo(payload.sourceWindowLabel, "pty-return-drop-requested", {
            instanceId: payload.instanceId,
            targetPaneId: pane.id,
          }).catch((reason) =>
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
          {paneSlots.length === 0 && (
            <span className="pty-pane-empty-title">{t("pty.emptyPane")}</span>
          )}
        </div>
        <div className="pty-pane-tabs">
          {previousSlots.length > 0 && (
            <PaneSessionStack
              side="before"
              sourcePaneId={pane.id}
              sessions={previousSlots}
              directories={directories}
              ptySessionsById={ptySessionsById}
              onActivate={(instanceId) =>
                onActivateSession(pane.id, instanceId)
              }
              onCloseSlot={onCloseSlot}
              onContextMenu={(instanceId, x, y) => {
                onFocusPane(pane.id);
                setContextMenu({ instanceId, x, y });
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
          {nextSlots.length > 0 && (
            <PaneSessionStack
              side="after"
              sourcePaneId={pane.id}
              sessions={nextSlots}
              directories={directories}
              ptySessionsById={ptySessionsById}
              onActivate={(instanceId) =>
                onActivateSession(pane.id, instanceId)
              }
              onCloseSlot={onCloseSlot}
              onContextMenu={(instanceId, x, y) => {
                onFocusPane(pane.id);
                setContextMenu({ instanceId, x, y });
              }}
            />
          )}
        </div>
        <div className="pty-pane-actions">
          {canCloseEmptyPane && paneSlots.length === 0 && (
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
        {paneSlots.length === 0 && (
          <div className="pty-workspace-empty">{t("pty.empty")}</div>
        )}
      </div>
      {contextMenu && (
        <PtySessionContextMenu
          pane={pane}
          instanceId={contextMenu.instanceId}
          slots={slots}
          ptySessionsById={ptySessionsById}
          workspacePanes={workspacePanes}
          directories={directories}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          onActivateSession={() =>
            onActivateSession(pane.id, contextMenu.instanceId)
          }
          onCloseSlot={(slot) => {
            setContextMenu(null);
            void onCloseSlot(slot);
          }}
          onCloseSlots={(targetSlots) => {
            setContextMenu(null);
            void onCloseSlots(targetSlots);
          }}
          onSplitPane={(direction, instanceId) => {
            setContextMenu(null);
            requestSplit(direction, instanceId);
          }}
          onSplitAndMove={(direction, instanceId) => {
            setContextMenu(null);
            requestSplitAndMove(direction, instanceId);
          }}
          onMoveSession={(destinationPaneId, instanceId) => {
            setContextMenu(null);
            onMoveSession(pane.id, destinationPaneId, instanceId);
          }}
          onDetachSession={(instanceId) => {
            setContextMenu(null);
            onDetachSession(instanceId);
          }}
        />
      )}
    </section>
  );
}

function PaneSessionStack({
  side,
  sourcePaneId,
  sessions,
  directories,
  ptySessionsById,
  onActivate,
  onCloseSlot,
  onContextMenu,
}: {
  side: "before" | "after";
  sourcePaneId: string;
  sessions: PtyWorkspaceSlot[];
  directories: { id: number; name: string }[];
  ptySessionsById: Record<string, PtySession>;
  onActivate: (instanceId: string) => void;
  onCloseSlot: (slot: PtyWorkspaceSlot) => void;
  onContextMenu: (instanceId: string, x: number, y: number) => void;
}) {
  const { t } = useTranslation();
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const label = t(
    side === "before" ? "pty.previousSessions" : "pty.nextSessions",
    { count: sessions.length },
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
        <span>{sessions.length}</span>
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
            {sessions.map((slot) => {
              const tool = TOOLS.find((entry) => entry.key === slot.toolKey)!;
              const ToolIcon = tool.icon;
              const session =
                !slot.restoredState && slot.sessionId
                  ? ptySessionsById[slot.sessionId]
                  : undefined;
              const title = workspaceSlotTitle(slot, directories);

              return (
                <div
                  className="pty-pane-session-stack-entry"
                  key={slot.instanceId}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setOpen(false);
                    onContextMenu(
                      slot.instanceId,
                      event.clientX,
                      event.clientY,
                    );
                  }}
                >
                  <button
                    type="button"
                    className="pty-pane-session-stack-session"
                    title={title}
                    aria-label={title}
                    draggable
                    onDragStart={(event) => {
                      beginWorkspaceSessionDrag(
                        event,
                        sourcePaneId,
                        slot.instanceId,
                      );
                    }}
                    onDragEnd={() => setOpen(false)}
                    onClick={() => {
                      setOpen(false);
                      onActivate(slot.instanceId);
                    }}
                  >
                    <ToolIcon size={14} />
                    <span
                      className={clsx("pty-pane-tab-status", {
                        running: session?.state === "running",
                        failed:
                          session?.state === "failed" ||
                          isInvalidRestoredSlotState(slot.restoredState),
                      })}
                      aria-hidden="true"
                    />
                    <span>{title}</span>
                  </button>
                  <button
                    type="button"
                    className="pty-pane-session-stack-close"
                    title={t("pty.close")}
                    aria-label={t("pty.closeNamed", { name: title })}
                    onClick={() => void onCloseSlot(slot)}
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
  const payload = encodePtySessionDrag({
    instanceId,
    sourcePaneId,
    sourceWindowLabel: "main",
  });
  event.dataTransfer.setData(PTY_SESSION_DRAG_TYPE, payload);
  event.dataTransfer.setData("text/plain", payload);
}

interface PtySessionContextMenuProps {
  pane: WorkspacePane;
  instanceId: string;
  slots: PtyWorkspaceSlot[];
  ptySessionsById: Record<string, PtySession>;
  workspacePanes: WorkspacePane[];
  directories: { id: number; name: string }[];
  x: number;
  y: number;
  onClose: () => void;
  onActivateSession: () => void;
  onCloseSlot: (slot: PtyWorkspaceSlot) => void;
  onCloseSlots: (slots: PtyWorkspaceSlot[]) => void;
  onSplitPane: (direction: SplitDirection, instanceId: string) => void;
  onSplitAndMove: (direction: SplitDirection, instanceId: string) => void;
  onMoveSession: (destinationPaneId: string, instanceId: string) => void;
  onDetachSession: (instanceId: string) => void;
}

function PtySessionContextMenu({
  pane,
  instanceId,
  slots,
  ptySessionsById,
  workspacePanes,
  directories,
  x,
  y,
  onClose,
  onActivateSession,
  onCloseSlot,
  onCloseSlots,
  onSplitPane,
  onSplitAndMove,
  onMoveSession,
  onDetachSession,
}: PtySessionContextMenuProps) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const moveButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const [moveSubmenuOpen, setMoveSubmenuOpen] = useState(false);
  const [submenuPosition, setSubmenuPosition] = useState({ left: 8, top: 8 });
  const [position, setPosition] = useState({ left: x, top: y });
  const slot = slots.find((candidate) => candidate.instanceId === instanceId);
  const session =
    slot?.sessionId && !slot.restoredState
      ? ptySessionsById[slot.sessionId]
      : undefined;
  const paneSlots = pane.sessionIds
    .map((sessionId) =>
      slots.find((candidate) => candidate.instanceId === sessionId),
    )
    .filter((candidate): candidate is PtyWorkspaceSlot => Boolean(candidate));
  const otherPanes = workspacePanes.filter(
    (candidate) => candidate.id !== pane.id,
  );
  const otherSessions = paneSlots.filter(
    (candidate) => candidate.instanceId !== instanceId,
  );
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const bounds = menu.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8)),
    });
  }, [moveSubmenuOpen, x, y]);

  useLayoutEffect(() => {
    if (!moveSubmenuOpen) return;
    const anchor = moveButtonRef.current;
    const submenu = submenuRef.current;
    if (!anchor || !submenu) return;
    const anchorBounds = anchor.getBoundingClientRect();
    const submenuBounds = submenu.getBoundingClientRect();
    const gap = 4;
    const padding = 8;
    const placeRight =
      window.innerWidth - anchorBounds.right >=
      submenuBounds.width + gap + padding;
    const left = placeRight
      ? anchorBounds.right + gap
      : Math.max(padding, anchorBounds.left - submenuBounds.width - gap);
    const top = Math.max(
      padding,
      Math.min(
        anchorBounds.top - 5,
        window.innerHeight - submenuBounds.height - padding,
      ),
    );
    setSubmenuPosition({ left, top });
    submenuRef.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
      ?.focus();
  }, [moveSubmenuOpen]);

  useEffect(() => {
    menuRef.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
      ?.focus();
    const dismissOutside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        onCloseRef.current();
      }
    };
    const dismissEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("pointerdown", dismissOutside, true);
    document.addEventListener("keydown", dismissEscape, true);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside, true);
      document.removeEventListener("keydown", dismissEscape, true);
    };
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "ArrowLeft" && moveSubmenuOpen) {
      event.preventDefault();
      setMoveSubmenuOpen(false);
      moveButtonRef.current?.focus();
      return;
    }
    if (
      event.key === "ArrowRight" &&
      event.target === moveButtonRef.current &&
      otherPanes.length > 0
    ) {
      event.preventDefault();
      setMoveSubmenuOpen(true);
      return;
    }
    if (
      event.key !== "ArrowDown" &&
      event.key !== "ArrowUp" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      ) ?? [],
    ).filter((item) => item.getClientRects().length > 0);
    if (items.length === 0) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
            items.length;
    items[nextIndex].focus();
  };

  if (!slot) return null;

  return createPortal(
    <div
      ref={menuRef}
      className="pty-session-context-menu"
      role="menu"
      aria-label={t("pty.sessionMenu")}
      style={{ left: position.left, top: position.top }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={handleKeyDown}
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => onSplitPane("horizontal", instanceId)}
      >
        {t("pty.splitRight")}
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => onSplitPane("vertical", instanceId)}
      >
        {t("pty.splitDown")}
      </button>
      <div className="pty-session-menu-separator" role="separator" />
      <button
        type="button"
        role="menuitem"
        disabled={session?.state !== "running"}
        onClick={() => onDetachSession(instanceId)}
      >
        {t("pty.openSeparateWindow")}
      </button>
      <div className="pty-session-menu-separator" role="separator" />
      <button
        type="button"
        role="menuitem"
        onClick={() => onSplitAndMove("horizontal", instanceId)}
      >
        {t("pty.splitAndMoveRight")}
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => onSplitAndMove("vertical", instanceId)}
      >
        {t("pty.splitAndMoveDown")}
      </button>
      <div className="pty-session-menu-submenu">
        <button
          ref={moveButtonRef}
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={moveSubmenuOpen}
          disabled={otherPanes.length === 0}
          onClick={() => setMoveSubmenuOpen((open) => !open)}
        >
          <span>{t("pty.moveToPane")}</span>
          <ChevronRight size={14} />
        </button>
        {moveSubmenuOpen && otherPanes.length > 0 && (
          <div
            ref={submenuRef}
            className="pty-session-submenu-items"
            role="menu"
            aria-label={t("pty.moveToPane")}
            style={{ left: submenuPosition.left, top: submenuPosition.top }}
          >
            {otherPanes.map((targetPane) => (
              <button
                type="button"
                role="menuitem"
                key={targetPane.id}
                onClick={() => onMoveSession(targetPane.id, instanceId)}
              >
                {workspacePaneTitle(
                  targetPane,
                  slots,
                  directories,
                  t("pty.paneNumber", { number: targetPane.paneNumber }),
                  t("pty.emptyPane"),
                )}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="pty-session-menu-separator" role="separator" />
      <button
        type="button"
        role="menuitem"
        className="danger"
        onClick={() => onCloseSlot(slot)}
      >
        {t("pty.closeCurrent")}
      </button>
      <button
        type="button"
        role="menuitem"
        className="danger"
        disabled={otherSessions.length === 0}
        onClick={() => {
          onActivateSession();
          onCloseSlots(otherSessions);
        }}
      >
        {t("pty.closeOthers", { count: otherSessions.length })}
      </button>
      <button
        type="button"
        role="menuitem"
        className="danger"
        disabled={paneSlots.length === 0}
        onClick={() => onCloseSlots(paneSlots)}
      >
        {t("pty.closeAllInPane", { count: paneSlots.length })}
      </button>
    </div>,
    document.body,
  );
}

function workspacePaneTitle(
  pane: WorkspacePane,
  slots: PtyWorkspaceSlot[],
  directories: { id: number; name: string }[],
  paneName: string,
  emptyPaneLabel: string,
): string {
  const activeSlot = pane.activeSessionId
    ? slots.find((slot) => slot.instanceId === pane.activeSessionId)
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

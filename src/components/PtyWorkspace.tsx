import clsx from "clsx";
import { Allotment } from "allotment";
import { emitTo, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  ChevronDown,
  ChevronRight,
  Columns2,
  Layers,
  Rows2,
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
import {
  type WorkspaceNode,
  activateWorkspaceSession,
  addSessionToWorkspacePane,
  canSplitWorkspacePane,
  createWorkspacePane,
  findWorkspacePane,
  listVisibleWorkspaceSessionIds,
  listWorkspacePanes,
  moveWorkspaceSession,
  MIN_WORKSPACE_PANE_HEIGHT,
  MIN_WORKSPACE_PANE_WIDTH,
  minimumWorkspacePaneExtent,
  removeEmptyWorkspacePane,
  removeWorkspaceSession,
  setWorkspaceSplitRatio,
  splitAndMoveWorkspaceSession,
  splitWorkspacePane,
  type SplitDirection,
  type WorkspacePane,
} from "../lib/ptyWorkspaceLayout";
import {
  encodePtySessionDrag,
  parsePtySessionDrag,
  PTY_SESSION_DRAG_TYPE,
} from "../lib/ptySessionDrag";
import type { PtySession, ToolKey } from "../lib/tauri";
import { getTerminalTitleLabel, TOOLS } from "../lib/tools";
import { useAppStore } from "../store/appStore";
import { AnchoredPopover } from "./AnchoredPopover";
import { PtyTerminal, type PtyTerminalHandle } from "./PtyTerminal";
import "allotment/dist/style.css";

interface PtyWorkspaceSlot {
  instanceId: string;
  directoryId: number;
  toolKey: ToolKey;
  sequence: number;
  resumeSessionId?: string;
  sessionId?: string;
}

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
  focusedPaneId: string;
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
  hasDetachedSessions: boolean;
  isManagedDetachedDrag: (instanceId: string, windowLabel: string) => boolean;
  detachSession: (instanceId: string) => Promise<void>;
  closeEmptyPane: (paneId: string) => void;
  updateSplitRatio: (splitId: string, sizes: number[]) => void;
  removeSlot: (instanceId: string) => void;
  recordSession: (instanceId: string, session: PtySession | null) => void;
}

const PtyWorkspaceContext = createContext<PtyWorkspaceContextValue | null>(
  null,
);

export function PtyWorkspaceProvider({ children }: { children: ReactNode }) {
  const { data: directories } = useDirectories();
  const [initialPaneId] = useState<string>(() => crypto.randomUUID());
  const [slots, setSlots] = useState<PtyWorkspaceSlot[]>([]);
  const [tree, setTree] = useState<WorkspaceNode>(() =>
    createWorkspacePane(initialPaneId),
  );
  const [focusedPaneId, setFocusedPaneId] = useState(initialPaneId);
  const [portalTargets, setPortalTargets] = useState<
    Record<string, HTMLDivElement>
  >({});
  const [detachedInstanceIds, setDetachedInstanceIds] = useState<Set<string>>(
    () => new Set(),
  );
  const terminalRefs = useRef(new Map<string, PtyTerminalHandle>());
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
  treeRef.current = tree;
  focusedPaneIdRef.current = focusedPaneId;

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
      if (activeSlot) {
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
      const currentSlots = slotsRef.current;
      const sequence =
        Math.max(
          0,
          ...currentSlots
            .filter(
              (slot) =>
                slot.directoryId === directoryId && slot.toolKey === toolKey,
            )
            .map((slot) => slot.sequence),
        ) + 1;
      const slot: PtyWorkspaceSlot = {
        instanceId: crypto.randomUUID(),
        directoryId,
        toolKey,
        sequence,
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
    [commitTree, setFocusedPane],
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
      if (slot) {
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
        throw new Error("该终端当前无法移动到独立窗口");
      }
      const currentSession = useAppStore.getState().ptySessionsById[sessionId];
      if (currentSession?.state !== "running") {
        throw new Error("只有运行中的终端可以移动到独立窗口");
      }
      const terminal = terminalRefs.current.get(instanceId);
      if (!terminal) throw new Error("终端尚未准备好，请稍后重试");

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

      try {
        await new Promise<void>((resolve, reject) => {
          const child = new WebviewWindow(windowLabel, {
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
            reject(new Error("独立终端窗口启动超时"));
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
            reject(new Error(String(event.payload ?? "独立终端窗口创建失败")));
          });
        });
      } catch (reason) {
        await terminal.cancelHandoff(handoff.token).catch(() => undefined);
        throw reason;
      }
    },
    [directories, terminalRefs],
  );

  const handleDetachedReady = useCallback(
    (payload: DetachedWindowReadyEvent) => {
      const pending = pendingDetachedRef.current.get(payload.instanceId);
      if (
        !pending ||
        pending.sessionId !== payload.sessionId ||
        pending.windowLabel !== payload.windowLabel
      ) {
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
      if (!pending || pending.windowLabel !== payload.windowLabel) return;
      pendingDetachedRef.current.delete(payload.instanceId);
      window.clearTimeout(pending.timer);
      pending.reject(new Error(payload.message || "独立终端窗口启动失败"));
      void pending.window.destroy().catch(() => undefined);
    },
    [],
  );

  const handlePtyReturnRequest = useCallback(
    async (payload: PtyReturnRequestEvent) => {
      const detached = detachedByInstanceRef.current.get(payload.instanceId);
      const fail = (message: string) =>
        void emitTo(payload.windowLabel, "pty-return-failed", {
          instanceId: payload.instanceId,
          token: payload.token,
          message,
        }).catch(() => undefined);
      if (
        !detached ||
        detached.sessionId !== payload.sessionId ||
        detached.windowLabel !== payload.windowLabel
      ) {
        fail("主工作区中找不到这个终端会话");
        return;
      }
      const slot = slotsRef.current.find(
        (candidate) => candidate.instanceId === payload.instanceId,
      );
      const terminal = terminalRefs.current.get(payload.instanceId);
      if (!slot || !terminal) {
        fail("主工作区终端尚未准备好");
        return;
      }
      try {
        await terminal.attachHandoff(payload.sessionId, payload.token);
        const currentTree = treeRef.current;
        const targetPane =
          (payload.targetPaneId &&
            findWorkspacePane(currentTree, payload.targetPaneId)) ||
          findWorkspacePane(currentTree, focusedPaneIdRef.current) ||
          listWorkspacePanes(currentTree)[0];
        const nextTree = addSessionToWorkspacePane(
          currentTree,
          targetPane.id,
          payload.instanceId,
        );
        commitTree(nextTree);
        setFocusedPane(targetPane.id);
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
    [commitTree, setFocusedPane, terminalRefs],
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
        const detached = detachedByInstanceRef.current.get(
          event.payload.instanceId,
        );
        if (
          detached?.sessionId === event.payload.sessionId &&
          detached.windowLabel === event.payload.windowLabel
        ) {
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
  ]);

  const closeEmptyPane = useCallback(
    (paneId: string) => {
      const pane = findWorkspacePane(treeRef.current, paneId);
      if (!pane || pane.sessionIds.length > 0) return;
      const next = removeEmptyWorkspacePane(treeRef.current, paneId);
      commitTree(next);
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
    (splitId: string, sizes: number[]) => {
      const total = sizes.reduce((sum, size) => sum + size, 0);
      if (sizes.length !== 2 || total <= 0 || !Number.isFinite(total)) return;
      commitTree(
        setWorkspaceSplitRatio(treeRef.current, splitId, sizes[0] / total),
      );
    },
    [commitTree],
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

  const value = useMemo(
    () => ({
      slots,
      tree,
      focusedPaneId,
      portalTargets,
      terminalRefs,
      launchSession,
      focusPane,
      activateSession,
      splitPane,
      splitAndMoveSession,
      moveSession,
      hasDetachedSessions: detachedInstanceIds.size > 0,
      isManagedDetachedDrag,
      detachSession,
      closeEmptyPane,
      updateSplitRatio,
      removeSlot,
      recordSession,
    }),
    [
      slots,
      tree,
      focusedPaneId,
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
      removeSlot,
      recordSession,
    ],
  );

  return (
    <PtyWorkspaceContext.Provider value={value}>
      {children}
      <PtySessionRegistry
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

export function PtyWorkspaceRegion() {
  const { t } = useTranslation();
  const {
    slots,
    tree,
    focusedPaneId,
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
    removeSlot,
  } = usePtyWorkspace();
  const { data: directories } = useDirectories();
  const ptySessionsById = useAppStore((state) => state.ptySessionsById);
  const selectedDirectoryId = useAppStore((state) => state.selectedDirectoryId);

  const closeSlot = async (slot: PtyWorkspaceSlot) => {
    const terminal = terminalRefs.current.get(slot.instanceId);
    if (!terminal) return;
    const result = await terminal.closeSession();
    if (result === "closed") removeSlot(slot.instanceId);
  };

  const closeSlots = async (targetSlots: PtyWorkspaceSlot[]) => {
    if (targetSlots.length === 0) return;
    const runningCount = targetSlots.filter(
      (slot) =>
        slot.sessionId && ptySessionsById[slot.sessionId]?.state === "running",
    ).length;
    if (
      runningCount > 0 &&
      !window.confirm(t("pty.confirmCloseMany", { count: runningCount }))
    ) {
      return;
    }

    const results = await Promise.all(
      targetSlots.map(async (slot) => {
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
      <WorkspaceTreeView
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
    </section>
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
  onSplitResize: (splitId: string, sizes: number[]) => void;
  onCloseSlot: (slot: PtyWorkspaceSlot) => void;
  onCloseSlots: (slots: PtyWorkspaceSlot[]) => void;
}

function WorkspaceTreeView(props: WorkspaceTreeViewProps) {
  const { node, onSplitResize } = props;
  if (node.kind === "pane") return <WorkspacePaneView {...props} pane={node} />;

  const firstSize = String(Math.round(node.ratio * 10000) / 100) + "%";
  const secondSize = String(Math.round((1 - node.ratio) * 10000) / 100) + "%";
  return (
    <Allotment
      id={node.id}
      className="pty-workspace-split"
      vertical={node.direction === "vertical"}
      proportionalLayout
      separator
      onDragEnd={(sizes) => onSplitResize(node.id, sizes)}
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
    const session = slot.sessionId
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
              failed: session?.state === "failed",
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
              const session = slot.sessionId
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
                        failed: session?.state === "failed",
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
  const session = slot?.sessionId ? ptySessionsById[slot.sessionId] : undefined;
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
  const directory = directories.find((entry) => entry.id === slot.directoryId);
  const toolLabel = getTerminalTitleLabel(slot.toolKey);
  return (
    (directory?.name ?? toolLabel) +
    "-" +
    toolLabel +
    "-" +
    String(slot.sequence).padStart(2, "0")
  );
}

function PtySessionRegistry({
  slots,
  tree,
  focusedPaneId,
  active,
  detachedInstanceIds,
  terminalRefs,
  onSessionChange,
  onPortalTarget,
  onFocusPane,
}: {
  slots: PtyWorkspaceSlot[];
  tree: WorkspaceNode;
  focusedPaneId: string;
  active: boolean;
  detachedInstanceIds: Set<string>;
  terminalRefs: MutableRefObject<Map<string, PtyTerminalHandle>>;
  onSessionChange: (instanceId: string, session: PtySession | null) => void;
  onPortalTarget: (instanceId: string, target: HTMLDivElement | null) => void;
  onFocusPane: (paneId: string) => void;
}) {
  const activeSessionId = findWorkspacePane(
    tree,
    focusedPaneId,
  )?.activeSessionId;
  const panes = listWorkspacePanes(tree);
  const visibleSessionIds = new Set(listVisibleWorkspaceSessionIds(tree));

  return (
    <div className="pty-session-registry" hidden aria-hidden="true">
      {slots.map((slot) => {
        const pane = panes.find((candidate) =>
          candidate.sessionIds.includes(slot.instanceId),
        );
        return (
          <PtySessionPortal
            key={slot.instanceId}
            slot={slot}
            assigned={Boolean(pane)}
            active={
              active &&
              pane?.id === focusedPaneId &&
              activeSessionId === slot.instanceId
            }
            visible={
              active &&
              visibleSessionIds.has(slot.instanceId) &&
              !detachedInstanceIds.has(slot.instanceId)
            }
            interactive={
              active &&
              pane?.id === focusedPaneId &&
              activeSessionId === slot.instanceId &&
              !detachedInstanceIds.has(slot.instanceId)
            }
            terminalRefs={terminalRefs}
            onSessionChange={onSessionChange}
            onPortalTarget={onPortalTarget}
            onFocusPane={pane ? () => onFocusPane(pane.id) : undefined}
          />
        );
      })}
    </div>
  );
}

function PtySessionPortal({
  slot,
  assigned,
  active,
  visible,
  interactive,
  terminalRefs,
  onSessionChange,
  onPortalTarget,
  onFocusPane,
}: {
  slot: PtyWorkspaceSlot;
  assigned: boolean;
  active: boolean;
  visible: boolean;
  interactive: boolean;
  terminalRefs: MutableRefObject<Map<string, PtyTerminalHandle>>;
  onSessionChange: (instanceId: string, session: PtySession | null) => void;
  onPortalTarget: (instanceId: string, target: HTMLDivElement | null) => void;
  onFocusPane?: () => void;
}) {
  const [target] = useState(() => {
    const element = document.createElement("div");
    element.className = "pty-pane-session";
    element.dataset.instanceId = slot.instanceId;
    return element;
  });
  const setTerminalRef = useCallback(
    (terminal: PtyTerminalHandle | null) => {
      if (terminal) terminalRefs.current.set(slot.instanceId, terminal);
      else terminalRefs.current.delete(slot.instanceId);
    },
    [slot.instanceId, terminalRefs],
  );

  useLayoutEffect(() => {
    onPortalTarget(slot.instanceId, target);
    return () => {
      target.remove();
      onPortalTarget(slot.instanceId, null);
    };
  }, [onPortalTarget, slot.instanceId, target]);

  useLayoutEffect(() => {
    if (!assigned) target.hidden = true;
  }, [assigned, target]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      void terminalRefs.current
        .get(slot.instanceId)
        ?.startSession(slot.directoryId, slot.toolKey, slot.resumeSessionId);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    slot.instanceId,
    slot.directoryId,
    slot.toolKey,
    slot.resumeSessionId,
    terminalRefs,
  ]);

  return createPortal(
    <PtyTerminal
      ref={setTerminalRef}
      active={active}
      visible={visible}
      interactive={interactive}
      onFocus={onFocusPane}
      onSessionChange={(session) => onSessionChange(slot.instanceId, session)}
    />,
    target,
  );
}

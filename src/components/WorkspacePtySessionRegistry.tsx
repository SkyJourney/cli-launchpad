import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  type MutableRefObject,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  findWorkspacePane,
  listVisibleWorkspaceSessionIds,
  listWorkspacePanes,
  type WorkspaceNode,
} from "../lib/ptyWorkspaceLayout";
import type {
  PtySession,
  ToolKey,
  WorkspaceSlotStateKind,
  WorkspaceSlotTitle,
} from "../lib/tauri";
import { PtyTerminal, type PtyTerminalHandle } from "./PtyTerminal";

export interface PtyWorkspaceSlot {
  instanceId: string;
  directoryId: number;
  directoryPath: string;
  projectName: string;
  toolKey: ToolKey;
  sequence: number;
  title: WorkspaceSlotTitle;
  resumeSessionId?: string | null;
  sessionId?: string | null;
  restoredState?: WorkspaceSlotStateKind;
}

export function WorkspacePtySessionRegistry({
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
    if (slot.restoredState) return;
    const frame = window.requestAnimationFrame(() => {
      void terminalRefs.current
        .get(slot.instanceId)
        ?.startSession(
          slot.directoryId,
          slot.toolKey,
          slot.resumeSessionId ?? undefined,
        );
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    slot.instanceId,
    slot.directoryId,
    slot.toolKey,
    slot.resumeSessionId,
    slot.restoredState,
    terminalRefs,
  ]);

  return createPortal(
    slot.restoredState ? (
      <RestoredWorkspaceSlotPlaceholder state={slot.restoredState} />
    ) : (
      <PtyTerminal
        ref={setTerminalRef}
        active={active}
        visible={visible}
        interactive={interactive}
        onFocus={onFocusPane}
        onSessionChange={(session) => onSessionChange(slot.instanceId, session)}
      />
    ),
    target,
  );
}

function RestoredWorkspaceSlotPlaceholder({
  state,
}: {
  state: WorkspaceSlotStateKind;
}) {
  const { t } = useTranslation();
  const messageKey =
    state === "missingProject"
      ? "pty.restoredMissingProject"
      : state === "projectIdentityMismatch"
        ? "pty.restoredProjectMismatch"
        : state === "missingSession"
          ? "pty.restoredMissingSession"
          : state === "sessionIdentityMismatch"
            ? "pty.restoredSessionMismatch"
            : "pty.restoredEnded";

  return (
    <div className="pty-restored-placeholder" role="status">
      <p>{t(messageKey)}</p>
    </div>
  );
}

import type { PtyTerminalHandle } from "../../components/PtyTerminal";
import type { PtyWorkspaceSlot } from "../../components/WorkspacePtySessionRegistry";
import { nextWorkspaceSessionSequence } from "../../lib/ptyWorkspaceLayout";
import type { PtySession, ToolKey } from "../../lib/tauri";
import type { HostSnapshot } from "../host/workspaceHostStore";

export interface PtyDirectoryRef {
  id: number;
  path: string;
  name: string;
}

export interface PtySlotsDomain {
  /** Stable holder for live terminal handles; same shape as the facade's terminalRefs. */
  terminalRefs: { current: Map<string, PtyTerminalHandle> };
  createSlot: (
    slots: readonly PtyWorkspaceSlot[],
    directory: PtyDirectoryRef,
    toolKey: ToolKey,
    resumeSessionId?: string,
  ) => PtyWorkspaceSlot;
  addSlot: (live: HostSnapshot, slot: PtyWorkspaceSlot) => HostSnapshot;
  removeSlot: (
    live: HostSnapshot,
    instanceId: string,
  ) => { next: HostSnapshot; removed: PtyWorkspaceSlot | undefined };
  recordSession: (
    live: HostSnapshot,
    instanceId: string,
    session: PtySession,
  ) => HostSnapshot;
  upsertSession: (live: HostSnapshot, session: PtySession) => HostSnapshot;
  removeSession: (live: HostSnapshot, sessionId: string) => HostSnapshot;
  clearSessions: (live: HostSnapshot) => HostSnapshot;
  runningSessions: (live: HostSnapshot) => PtySession[];
  runningCountIn: (live: HostSnapshot, directoryId: number) => number;
}

/**
 * Pure reducers over the host snapshot. Slots and the tree are written in one
 * store.commit by the caller, so a slot is never observable outside the tree
 * (invariant I5). The terminal handle table is the only mutable object.
 */
export function createPtySlotsDomain(): PtySlotsDomain {
  return {
    terminalRefs: { current: new Map<string, PtyTerminalHandle>() },
    createSlot: (slots, directory, toolKey, resumeSessionId) => ({
      instanceId: crypto.randomUUID(),
      directoryId: directory.id,
      directoryPath: directory.path,
      projectName: directory.name,
      toolKey,
      sequence: nextWorkspaceSessionSequence(slots, directory.id, toolKey),
      title: { kind: "automatic" },
      resumeSessionId,
    }),
    addSlot: (live, slot) => ({ ...live, slots: [...live.slots, slot] }),
    removeSlot: (live, instanceId) => {
      const removed = live.slots.find((slot) => slot.instanceId === instanceId);
      if (!removed) return { next: live, removed: undefined };
      const sessions = { ...live.ptySessionsById };
      if (removed.sessionId) delete sessions[removed.sessionId];
      return {
        next: {
          ...live,
          slots: live.slots.filter((slot) => slot.instanceId !== instanceId),
          ptySessionsById: sessions,
        },
        removed,
      };
    },
    recordSession: (live, instanceId, session) => ({
      ...live,
      ptySessionsById: {
        ...live.ptySessionsById,
        [session.sessionId]: session,
      },
      slots: live.slots.map((slot) =>
        slot.instanceId === instanceId
          ? { ...slot, sessionId: session.sessionId }
          : slot,
      ),
    }),
    upsertSession: (live, session) => ({
      ...live,
      ptySessionsById: {
        ...live.ptySessionsById,
        [session.sessionId]: session,
      },
    }),
    removeSession: (live, sessionId) => {
      if (!live.ptySessionsById[sessionId]) return live;
      const sessions = { ...live.ptySessionsById };
      delete sessions[sessionId];
      return { ...live, ptySessionsById: sessions };
    },
    clearSessions: (live) => ({ ...live, ptySessionsById: {} }),
    runningSessions: (live) =>
      Object.values(live.ptySessionsById).filter(
        (session) => session.state === "running",
      ),
    runningCountIn: (live, directoryId) =>
      Object.values(live.ptySessionsById).filter(
        (session) =>
          session.directoryId === directoryId && session.state === "running",
      ).length,
  };
}

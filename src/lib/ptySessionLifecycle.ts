import type { PtyEvent, PtySession, PtySessionWindowStatus } from "./tauri";

type PtyExitEvent = Extract<PtyEvent, { type: "exited" }>;

export function applyPendingPtyExit(
  session: PtySession,
  pendingExit: PtyExitEvent | undefined,
): PtySession {
  if (!pendingExit || pendingExit.sessionId !== session.sessionId) {
    return session;
  }

  return {
    ...session,
    state: pendingExit.state,
    exitCode: pendingExit.exitCode,
  };
}

export type DetachedWindowFailureAction =
  | "close-ended"
  | "close-transferred"
  | "keep-open";

export interface DetachedWindowIdentity {
  instanceId: string;
  sessionId: string;
  windowLabel: string;
}

export function matchesDetachedWindow(
  expected: DetachedWindowIdentity | null | undefined,
  received: DetachedWindowIdentity,
): boolean {
  return Boolean(
    expected &&
    expected.instanceId === received.instanceId &&
    expected.sessionId === received.sessionId &&
    expected.windowLabel === received.windowLabel,
  );
}

export function resolveDetachedWindowFailureAction(
  localState: PtySession["state"] | null | undefined,
  windowStatus: PtySessionWindowStatus | null | undefined,
): DetachedWindowFailureAction {
  if (
    localState === "exited" ||
    localState === "terminated" ||
    localState === "failed" ||
    windowStatus === "ended"
  ) {
    return "close-ended";
  }
  if (windowStatus === "ownedByAnotherWindow") return "close-transferred";
  return "keep-open";
}

export type DetachedStartTimeoutAction =
  | "accept-detached-owner"
  | "cancel-source-handoff"
  | "remove-ended-session"
  | "retry-owner-query";

export function resolveDetachedStartTimeoutAction(
  windowStatus: PtySessionWindowStatus | null | undefined,
  detachedWindowExists: boolean,
): DetachedStartTimeoutAction {
  if (windowStatus === "ended") return "remove-ended-session";
  if (windowStatus === "ownedByAnotherWindow" && detachedWindowExists) {
    return "accept-detached-owner";
  }
  if (windowStatus == null) return "retry-owner-query";
  return "cancel-source-handoff";
}

export function canTerminatePtySession(
  state: PtySession["state"] | null | undefined,
  handoffInProgress: boolean,
): boolean {
  return state === "running" && !handoffInProgress;
}

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
  const state = windowStatus?.state;
  if (
    localState === "exited" ||
    localState === "terminated" ||
    localState === "failed" ||
    state === "ended"
  ) {
    return "close-ended";
  }
  if (state === "ownedByAnotherWindow") return "close-transferred";
  return "keep-open";
}

export type DetachedStartTimeoutAction =
  | "accept-detached-owner"
  | "cancel-source-handoff"
  | "reject-foreign-owner"
  | "remove-ended-session"
  | "retry-owner-query";

export function resolveDetachedStartTimeoutAction(
  windowStatus: PtySessionWindowStatus | null | undefined,
  child: { expectedChildLabel: string; childExists: boolean },
): DetachedStartTimeoutAction {
  if (windowStatus == null) return "retry-owner-query";
  if (windowStatus.state === "ended") return "remove-ended-session";
  if (windowStatus.state === "ownedByAnotherWindow") {
    // Rust 报告的所有者必须正是刚创建的子窗口，否则是外来窗口，不能接受。
    if (windowStatus.ownerLabel !== child.expectedChildLabel) {
      return "reject-foreign-owner";
    }
    return child.childExists
      ? "accept-detached-owner"
      : "cancel-source-handoff";
  }
  return "cancel-source-handoff";
}

export function canTerminatePtySession(
  state: PtySession["state"] | null | undefined,
  handoffInProgress: boolean,
): boolean {
  return state === "running" && !handoffInProgress;
}

/** 超时对账里“无法确认所有者”时的最大重试次数与间隔。 */
export const PTY_OWNER_QUERY_MAX_RETRIES = 10;
export const PTY_OWNER_QUERY_RETRY_DELAY_MS = 1_000;

export type OwnerQueryStep =
  | { kind: "retry"; retries: number }
  | { kind: "give-up" };

/** retriesSoFar 是已经安排过的重试次数；小于上限继续重试，否则放弃。 */
export function nextOwnerQueryStep(retriesSoFar: number): OwnerQueryStep {
  return retriesSoFar < PTY_OWNER_QUERY_MAX_RETRIES
    ? { kind: "retry", retries: retriesSoFar + 1 }
    : { kind: "give-up" };
}

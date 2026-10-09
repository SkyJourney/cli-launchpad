import { describe, expect, it } from "vitest";
import {
  applyPendingPtyExit,
  canTerminatePtySession,
  matchesDetachedWindow,
  nextOwnerQueryStep,
  PTY_OWNER_QUERY_MAX_RETRIES,
  resolveDetachedStartTimeoutAction,
  resolveDetachedWindowFailureAction,
} from "./ptySessionLifecycle";

const runningSession = {
  sessionId: "session-1",
  directoryId: 42,
  toolKey: "claude" as const,
  workingDirectory: "C:\\Projects\\sample",
  state: "running" as const,
  startedAtMs: 1,
  endedAtMs: null,
  exitCode: null,
};

describe("PTY session termination ownership", () => {
  it("allows the owning window to close a running session without keyboard focus", () => {
    expect(canTerminatePtySession("running", false)).toBe(true);
  });

  it("blocks termination while the PTY is being handed to another window", () => {
    expect(canTerminatePtySession("running", true)).toBe(false);
  });

  it("does not offer termination for a session that is not running", () => {
    expect(canTerminatePtySession("exited", false)).toBe(false);
    expect(canTerminatePtySession(null, false)).toBe(false);
  });
});

describe("PTY session handoff exit reconciliation", () => {
  it("applies an exit delivered before handoff metadata resolves", () => {
    expect(
      applyPendingPtyExit(runningSession, {
        type: "exited",
        sessionId: "session-1",
        state: "exited",
        exitCode: 0,
      }),
    ).toMatchObject({ state: "exited", exitCode: 0 });
  });

  it("does not apply an exit event for a different session", () => {
    expect(
      applyPendingPtyExit(runningSession, {
        type: "exited",
        sessionId: "session-2",
        state: "terminated",
        exitCode: 1,
      }),
    ).toBe(runningSession);
  });
});

describe("detached PTY window failure recovery", () => {
  it("closes when the local PTY has ended", () => {
    expect(
      resolveDetachedWindowFailureAction("exited", {
        state: "running",
        ownerLabel: "terminal-a",
      }),
    ).toBe("close-ended");
  });

  it("closes when Rust confirms that the PTY no longer exists", () => {
    expect(
      resolveDetachedWindowFailureAction(null, {
        state: "ended",
        ownerLabel: null,
      }),
    ).toBe("close-ended");
  });

  it("closes a stale child after another window owns the live PTY", () => {
    expect(
      resolveDetachedWindowFailureAction(null, {
        state: "ownedByAnotherWindow",
        ownerLabel: "terminal-b",
      }),
    ).toBe("close-transferred");
  });

  it("keeps a running PTY window open when return cannot be completed", () => {
    expect(
      resolveDetachedWindowFailureAction("running", {
        state: "running",
        ownerLabel: "main",
      }),
    ).toBe("keep-open");
  });
});

describe("detached PTY start timeout reconciliation", () => {
  it.each([
    [
      { state: "ownedByAnotherWindow", ownerLabel: "terminal-A" },
      "terminal-A",
      true,
      "accept-detached-owner",
    ],
    [
      { state: "ownedByAnotherWindow", ownerLabel: "terminal-B" },
      "terminal-A",
      true,
      "reject-foreign-owner",
    ],
    [
      { state: "ownedByAnotherWindow", ownerLabel: "terminal-A" },
      "terminal-A",
      false,
      "cancel-source-handoff",
    ],
    [
      { state: "running", ownerLabel: "main" },
      "terminal-A",
      true,
      "cancel-source-handoff",
    ],
    [
      { state: "ended", ownerLabel: null },
      "terminal-A",
      true,
      "remove-ended-session",
    ],
    [null, "terminal-A", true, "retry-owner-query"],
  ] as const)(
    "resolves %j against expected child %s (child exists=%s) to %s",
    (status, expectedChildLabel, childExists, expected) => {
      expect(
        resolveDetachedStartTimeoutAction(status, {
          expectedChildLabel,
          childExists,
        }),
      ).toBe(expected);
    },
  );

  it("never accepts a foreign owner even when the child window exists", () => {
    for (const ownerLabel of ["terminal-B", "", null]) {
      expect(
        resolveDetachedStartTimeoutAction(
          { state: "ownedByAnotherWindow", ownerLabel },
          { expectedChildLabel: "terminal-A", childExists: true },
        ),
      ).not.toBe("accept-detached-owner");
    }
  });
});

describe("detached PTY event identity", () => {
  const identity = {
    instanceId: "instance-1",
    sessionId: "session-1",
    windowLabel: "terminal-window-1",
  };

  it("accepts an event from the matching instance, session, and window", () => {
    expect(matchesDetachedWindow(identity, { ...identity })).toBe(true);
  });

  it.each([
    {
      instanceId: "instance-2",
      sessionId: "session-1",
      windowLabel: "terminal-window-1",
    },
    {
      instanceId: "instance-1",
      sessionId: "session-2",
      windowLabel: "terminal-window-1",
    },
    {
      instanceId: "instance-1",
      sessionId: "session-1",
      windowLabel: "terminal-window-2",
    },
  ])("rejects stale or mismatched event identity %#", (received) => {
    expect(matchesDetachedWindow(identity, received)).toBe(false);
  });

  it("rejects events when the owner has no pending or detached record", () => {
    expect(matchesDetachedWindow(undefined, identity)).toBe(false);
  });
});

describe("detached PTY owner query retry limit", () => {
  it("retries ten times and then gives up", () => {
    expect(PTY_OWNER_QUERY_MAX_RETRIES).toBe(10);
    for (let retriesSoFar = 0; retriesSoFar < 10; retriesSoFar += 1) {
      expect(nextOwnerQueryStep(retriesSoFar)).toEqual({
        kind: "retry",
        retries: retriesSoFar + 1,
      });
    }
    expect(nextOwnerQueryStep(10)).toEqual({ kind: "give-up" });
    expect(nextOwnerQueryStep(11)).toEqual({ kind: "give-up" });
  });
});

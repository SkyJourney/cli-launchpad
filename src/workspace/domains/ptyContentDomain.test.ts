import { describe, expect, it, vi } from "vitest";
import {
  createInitialHostSnapshot,
  WorkspaceHostStore,
} from "../host/workspaceHostStore";
import {
  createPtyContentDomain,
  type PtyContentDomainDeps,
} from "./ptyContentDomain";

const SLOT = {
  instanceId: "i1",
  directoryId: 1,
  directoryPath: "C:/project",
  projectName: "Project",
  toolKey: "claude",
  sequence: 1,
  title: { kind: "automatic" },
  sessionId: "s1",
};
const RUNNING = {
  sessionId: "s1",
  directoryId: 1,
  toolKey: "claude",
  workingDirectory: "C:/project",
  state: "running",
  startedAtMs: 1,
  endedAtMs: null,
  exitCode: null,
};
const REF = { kind: "pty" as const, slotId: "i1" };

function makeDeps(
  overrides: Partial<PtyContentDomainDeps> = {},
  handle: { closeSession: ReturnType<typeof vi.fn> } = {
    closeSession: vi.fn(async () => "closed"),
  },
): PtyContentDomainDeps & { removeSlot: ReturnType<typeof vi.fn> } {
  const store = new WorkspaceHostStore(createInitialHostSnapshot("p1"));
  store.commit(
    (live) => ({
      ...live,
      slots: [SLOT as never],
      ptySessionsById: { s1: RUNNING as never },
    }),
    "test:seed",
  );
  return {
    store,
    terminalRefs: { current: new Map([["i1", handle as never]]) },
    isWindowOwned: () => false,
    titleOf: vi.fn(() => "Project-Claude-01"),
    removeSlot: vi.fn(),
    ...overrides,
  } as never;
}

describe("ptyContentDomain", () => {
  it("closeInput is undefined for a missing slot", () => {
    const deps = makeDeps();
    const domain = createPtyContentDomain(deps);

    expect(domain.closeInput({ kind: "pty", slotId: "nope" })).toBeUndefined();
    expect(deps.titleOf).not.toHaveBeenCalled();
  });

  it("closeInput is undefined for window-owned content", () => {
    const domain = createPtyContentDomain(
      makeDeps({ isWindowOwned: () => true }),
    );

    expect(domain.closeInput(REF)).toBeUndefined();
  });

  it("closeInput reports a running session with the presented title", () => {
    const deps = makeDeps();
    const domain = createPtyContentDomain(deps);

    expect(domain.closeInput(REF)).toEqual({
      title: "Project-Claude-01",
      isDirty: false,
      isRunning: true,
    });
    expect(deps.titleOf).toHaveBeenCalledWith(REF);
  });

  it("closeInput reports not running when the session is missing or ended", () => {
    const missing = makeDeps();
    missing.store.commit(
      (live) => ({ ...live, ptySessionsById: {} }),
      "test:none",
    );
    const ended = makeDeps();
    ended.store.commit(
      (live) => ({
        ...live,
        ptySessionsById: { s1: { ...RUNNING, state: "exited" } as never },
      }),
      "test:ended",
    );

    expect(createPtyContentDomain(missing).closeInput(REF)).toEqual({
      title: "Project-Claude-01",
      isDirty: false,
      isRunning: false,
    });
    expect(createPtyContentDomain(ended).closeInput(REF)).toEqual({
      title: "Project-Claude-01",
      isDirty: false,
      isRunning: false,
    });
  });

  it("close treats a restored slot as closed without touching a terminal", async () => {
    const deps = makeDeps();
    deps.store.commit(
      (live) => ({
        ...live,
        slots: [{ ...SLOT, restoredState: "missingSession" } as never],
      }),
      "test:restored",
    );
    deps.terminalRefs.current.clear();
    const domain = createPtyContentDomain(deps);

    await expect(domain.close([REF], "tab")).resolves.toEqual({
      closed: [REF],
      pending: [],
      failed: [],
    });
    expect(deps.removeSlot).toHaveBeenCalledTimes(1);
    expect(deps.removeSlot).toHaveBeenCalledWith("i1", {
      disposeOwnerEnded: false,
    });
  });

  it.each([
    ["closed", { closed: [REF], pending: [], failed: [] }],
    ["pending", { closed: [], pending: [REF], failed: [] }],
    ["terminating", { closed: [], pending: [REF], failed: [] }],
  ])("close maps a %s terminal outcome", async (outcome, expected) => {
    const handle = { closeSession: vi.fn(async () => outcome) };
    const deps = makeDeps({}, handle);
    const domain = createPtyContentDomain(deps);

    await expect(domain.close([REF], "menu")).resolves.toEqual(expected);
    expect(handle.closeSession).toHaveBeenCalledTimes(1);
    expect(handle.closeSession).toHaveBeenCalledWith(false);
    if (outcome === "closed") {
      expect(deps.removeSlot).toHaveBeenCalledWith("i1", {
        disposeOwnerEnded: false,
      });
    } else {
      expect(deps.removeSlot).not.toHaveBeenCalled();
    }
  });

  it("close reports a missing terminal handle as failed", async () => {
    const deps = makeDeps();
    deps.terminalRefs.current.clear();
    const domain = createPtyContentDomain(deps);

    await expect(domain.close([REF], "stack")).resolves.toEqual({
      closed: [],
      pending: [],
      failed: [REF],
    });
    expect(deps.removeSlot).not.toHaveBeenCalled();
  });

  it("close reports a throwing closeSession as failed", async () => {
    const handle = {
      closeSession: vi.fn(async () => {
        throw new Error("kill failed");
      }),
    };
    const deps = makeDeps({}, handle);
    const domain = createPtyContentDomain(deps);

    await expect(domain.close([REF], "menu")).resolves.toEqual({
      closed: [],
      pending: [],
      failed: [REF],
    });
    expect(deps.removeSlot).not.toHaveBeenCalled();
  });

  it("close keeps the order of the requested refs across mixed outcomes", async () => {
    const deps = makeDeps();
    deps.store.commit(
      (live) => ({
        ...live,
        slots: [
          SLOT as never,
          { ...SLOT, instanceId: "i2", sessionId: undefined } as never,
        ],
      }),
      "test:two-slots",
    );
    deps.terminalRefs.current.set("i2", {
      closeSession: vi.fn(async () => "pending"),
    } as never);
    const domain = createPtyContentDomain(deps);

    await expect(
      domain.close([REF, { kind: "pty", slotId: "i2" }], "menu"),
    ).resolves.toEqual({
      closed: [REF],
      pending: [{ kind: "pty", slotId: "i2" }],
      failed: [],
    });
  });

  it("close of an unknown slot reports it as failed", async () => {
    const domain = createPtyContentDomain(makeDeps());

    await expect(
      domain.close([{ kind: "pty", slotId: "nope" }], "tab"),
    ).resolves.toEqual({
      closed: [],
      pending: [],
      failed: [{ kind: "pty", slotId: "nope" }],
    });
  });
});

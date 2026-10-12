import { describe, expect, it } from "vitest";
import type { PtyWorkspaceSlot } from "../../components/WorkspacePtySessionRegistry";
import type { PtySession } from "../../lib/tauri";
import {
  createInitialHostSnapshot,
  type HostSnapshot,
} from "../host/workspaceHostStore";
import { createPtySlotsDomain } from "./ptySlotsDomain";

const domain = createPtySlotsDomain();

function snap(overrides: Partial<HostSnapshot> = {}): HostSnapshot {
  return { ...createInitialHostSnapshot("p1"), ...overrides };
}

function slotOf(
  id: string,
  extra: Partial<PtyWorkspaceSlot> = {},
): PtyWorkspaceSlot {
  return {
    instanceId: id,
    directoryId: 1,
    directoryPath: "C:/project",
    projectName: "Project",
    toolKey: "claude",
    sequence: 1,
    title: { kind: "automatic" },
    ...extra,
  } as PtyWorkspaceSlot;
}

function sessionOf(
  id: string,
  state: PtySession["state"] = "running",
  directoryId = 1,
): PtySession {
  return {
    sessionId: id,
    directoryId,
    toolKey: "claude",
    workingDirectory: "C:/project",
    state,
    startedAtMs: 1,
    endedAtMs: null,
    exitCode: null,
  } as unknown as PtySession;
}

describe("ptySlotsDomain", () => {
  it("createSlot numbers slots per project and tool and keeps the resume session id", () => {
    const existing = [
      slotOf("a", { sequence: 1 }),
      slotOf("b", { sequence: 3 }),
      slotOf("c", { directoryId: 2, sequence: 9 }),
      slotOf("d", { toolKey: "codex", sequence: 7 }),
    ];
    const directory = { id: 1, path: "C:/project", name: "Project" };

    const slot = domain.createSlot(existing, directory, "claude", "resume-1");

    expect(slot).toMatchObject({
      directoryId: 1,
      directoryPath: "C:/project",
      projectName: "Project",
      toolKey: "claude",
      sequence: 4,
      title: { kind: "automatic" },
      resumeSessionId: "resume-1",
    });
    expect(slot.instanceId).toMatch(/^[0-9a-f-]{36}$/);
    // 反向：没有 resumeSessionId 时为 undefined；两次调用的 instanceId 不同；输入数组不被修改。
    expect(
      domain.createSlot(existing, directory, "claude").resumeSessionId,
    ).toBeUndefined();
    expect(
      domain.createSlot(existing, directory, "claude").instanceId,
    ).not.toBe(slot.instanceId);
    expect(existing).toHaveLength(4);
  });

  it("addSlot appends the slot without touching other fields", () => {
    const live = snap({ slots: [slotOf("a")] });

    const next = domain.addSlot(live, slotOf("b"));

    expect(next.slots.map((s) => s.instanceId)).toEqual(["a", "b"]);
    expect(next.tree).toBe(live.tree);
    expect(next.documents).toBe(live.documents);
    expect(next.ptySessionsById).toBe(live.ptySessionsById);
    expect(live.slots).toHaveLength(1);
  });

  it("removeSlot removes the slot and its running session", () => {
    const live = snap({
      slots: [
        slotOf("a", { sessionId: "s-a" }),
        slotOf("b", { sessionId: "s-b" }),
      ],
      ptySessionsById: { "s-a": sessionOf("s-a"), "s-b": sessionOf("s-b") },
    });

    const result = domain.removeSlot(live, "a");

    expect(result.removed).toBe(live.slots[0]);
    expect(result.next.slots.map((s) => s.instanceId)).toEqual(["b"]);
    expect(Object.keys(result.next.ptySessionsById)).toEqual(["s-b"]);
    // 反向：输入快照未被修改；没有会话的槽位移除时会话表不变。
    expect(Object.keys(live.ptySessionsById)).toHaveLength(2);
    const noSession = snap({
      slots: [slotOf("c")],
      ptySessionsById: { "s-x": sessionOf("s-x") },
    });
    const unchanged = domain.removeSlot(noSession, "c");
    expect(unchanged.removed?.instanceId).toBe("c");
    expect(Object.keys(unchanged.next.ptySessionsById)).toEqual(["s-x"]);
  });

  it("removeSlot returns the same snapshot for an unknown slot", () => {
    const live = snap({ slots: [slotOf("a")] });

    const result = domain.removeSlot(live, "nope");

    expect(result.next).toBe(live);
    expect(result.removed).toBeUndefined();
  });

  it("recordSession stores the session and links it to the slot", () => {
    const live = snap({ slots: [slotOf("a"), slotOf("b")] });

    const next = domain.recordSession(live, "a", sessionOf("s-1"));

    expect(next.ptySessionsById["s-1"]).toEqual(sessionOf("s-1"));
    expect(next.slots[0]?.sessionId).toBe("s-1");
    expect(next.slots[1]?.sessionId).toBeUndefined();
    // 反向：对不存在的槽位仍写入会话（与 HEAD 的 upsertPtySession 一致），但没有槽位被链接。
    const orphan = domain.recordSession(live, "nope", sessionOf("s-2"));
    expect(orphan.ptySessionsById["s-2"]).toEqual(sessionOf("s-2"));
    expect(orphan.slots.every((slot) => slot.sessionId === undefined)).toBe(
      true,
    );
  });

  it("upsertSession replaces a session with the same id", () => {
    const live = snap({
      ptySessionsById: { "s-1": sessionOf("s-1", "running") },
    });

    const next = domain.upsertSession(live, sessionOf("s-1", "exited"));

    expect(next.ptySessionsById["s-1"]?.state).toBe("exited");
    expect(Object.keys(next.ptySessionsById)).toEqual(["s-1"]);
    expect(live.ptySessionsById["s-1"]?.state).toBe("running");
  });

  it("removeSession and clearSessions drop sessions", () => {
    const live = snap({
      ptySessionsById: { "s-1": sessionOf("s-1"), "s-2": sessionOf("s-2") },
    });

    expect(
      Object.keys(domain.removeSession(live, "s-1").ptySessionsById),
    ).toEqual(["s-2"]);
    expect(domain.removeSession(live, "nope")).toBe(live);
    expect(domain.clearSessions(live).ptySessionsById).toEqual({});
    // 反向：输入快照仍有两个会话。
    expect(Object.keys(live.ptySessionsById)).toHaveLength(2);
  });

  it("runningSessions and runningCountIn count only running sessions", () => {
    const live = snap({
      ptySessionsById: {
        "s-1": sessionOf("s-1", "running", 1),
        "s-2": sessionOf("s-2", "exited", 1),
        "s-3": sessionOf("s-3", "running", 2),
        "s-4": sessionOf("s-4", "failed", 1),
      },
    });

    expect(
      domain
        .runningSessions(live)
        .map((s) => s.sessionId)
        .sort(),
    ).toEqual(["s-1", "s-3"]);
    expect(domain.runningCountIn(live, 1)).toBe(1);
    expect(domain.runningCountIn(live, 2)).toBe(1);
    expect(domain.runningCountIn(live, 3)).toBe(0);
  });

  it("terminalRefs is a stable holder owned per domain instance", () => {
    const a = createPtySlotsDomain();
    const b = createPtySlotsDomain();

    expect(a.terminalRefs).toBe(a.terminalRefs);
    expect(a.terminalRefs.current).toBeInstanceOf(Map);
    expect(a.terminalRefs.current.size).toBe(0);
    a.terminalRefs.current.set("x", {} as never);
    expect(b.terminalRefs.current.size).toBe(0);
  });
});

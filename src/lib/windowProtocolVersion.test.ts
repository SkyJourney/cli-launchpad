// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import windowMessages from "../../contracts/window-messages.json";
import { tauriMock } from "../test/tauriMock";
import { onInboxEvent } from "./windowInbox";
import { onWindowMessage } from "./windowMessages";
import {
  resetVersionMismatchStateForTests,
  VERSION_MISMATCH_REPLIES,
} from "./windowProtocolVersion";

const MAIN = "main";
const TERMINAL = "terminal-8e783338-f464-4b10-b15e-b534748c6241";
const CONTENT = "workspace-content-11111111-2222-4333-8444-555555555555";

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  resetVersionMismatchStateForTests();
  vi.restoreAllMocks();
});

async function receive(
  label: string,
  type: string,
  version: number,
  payload: unknown,
  source: { label: string; kind: "main" | "terminal" | "workspaceContent" },
  handlers = 1,
) {
  tauriMock.setCurrentWindowLabel(label);
  const fns = Array.from({ length: handlers }, () => vi.fn());
  for (const fn of fns) await onWindowMessage(type, fn);
  tauriMock.deliverInbox(
    label,
    "window-message",
    { apiVersion: version, type, payload },
    source,
  );
  return fns;
}

const mismatchWarnings = () =>
  warn.mock.calls.filter((call) =>
    String(call[0]).startsWith("[protocol.version_mismatch]"),
  );

describe("wire protocol version mismatch", () => {
  it("warns and answers a file window init with an attach failure", async () => {
    const [handler] = await receive(
      CONTENT,
      "content-handoff-init",
      2,
      {
        content: { kind: "file", id: "doc-1" },
        transferId: "tok-1",
        payload: { windowLabel: CONTENT },
      },
      { label: MAIN, kind: "main" },
    );

    await vi.waitFor(() =>
      expect(tauriMock.state.relayedMessages).toHaveLength(1),
    );
    expect(handler).not.toHaveBeenCalled();
    expect(mismatchWarnings()).toHaveLength(1);
    expect(tauriMock.state.relayedMessages[0]).toEqual({
      from: CONTENT,
      target: MAIN,
      messageType: "content-handoff-failed",
      payload: {
        apiVersion: 1,
        type: "content-handoff-failed",
        payload: {
          content: { kind: "file", id: "doc-1" },
          transferId: "tok-1",
          payload: {
            windowLabel: CONTENT,
            message: "protocol.version_mismatch",
          },
        },
      },
    });
  });

  it("answers a PTY return request from an incompatible terminal window", async () => {
    tauriMock.setCurrentWindowLabel(TERMINAL);
    await onInboxEvent("window-message", vi.fn());
    const [handler] = await receive(
      MAIN,
      "content-handoff-return-requested",
      2,
      {
        content: { kind: "pty", id: "i1" },
        transferId: "t1",
        payload: { sessionId: "s1", windowLabel: TERMINAL },
      },
      { label: TERMINAL, kind: "terminal" },
    );

    await vi.waitFor(() =>
      expect(tauriMock.state.relayedMessages).toHaveLength(1),
    );
    expect(handler).not.toHaveBeenCalled();
    expect(tauriMock.state.relayedMessages[0]).toMatchObject({
      from: MAIN,
      target: TERMINAL,
      messageType: "content-handoff-return-failed",
      payload: {
        payload: {
          content: { kind: "pty", id: "i1" },
          transferId: "t1",
          payload: { message: "protocol.version_mismatch" },
        },
      },
    });
  });

  it("answers a file window return request from an incompatible content window", async () => {
    const [handler] = await receive(
      MAIN,
      "content-handoff-return-requested",
      2,
      {
        content: { kind: "file", id: "doc-2" },
        transferId: "tok-2",
        payload: { windowLabel: CONTENT },
      },
      { label: CONTENT, kind: "workspaceContent" },
    );

    await vi.waitFor(() =>
      expect(tauriMock.state.relayedMessages).toHaveLength(1),
    );
    expect(handler).not.toHaveBeenCalled();
    expect(tauriMock.state.relayedMessages[0]).toMatchObject({
      from: MAIN,
      target: CONTENT,
      messageType: "content-handoff-return-failed",
      payload: {
        payload: {
          content: { kind: "file", id: "doc-2" },
          transferId: "tok-2",
          payload: { message: "protocol.version_mismatch" },
        },
      },
    });
  });

  it("only warns for a message type without a failure counterpart", async () => {
    const [handler] = await receive(
      MAIN,
      "content-handoff-ready",
      2,
      {
        content: { kind: "pty", id: "i1" },
        transferId: null,
        payload: { sessionId: "s1", windowLabel: TERMINAL },
      },
      { label: TERMINAL, kind: "terminal" },
    );

    await vi.waitFor(() => expect(mismatchWarnings()).toHaveLength(1));
    expect(handler).not.toHaveBeenCalled();
    expect(tauriMock.state.relayedMessages).toEqual([]);
  });

  it("still delivers a message with the supported version to its handler", async () => {
    const [handler] = await receive(
      MAIN,
      "content-handoff-ready",
      1,
      {
        content: { kind: "pty", id: "i1" },
        transferId: null,
        payload: { sessionId: "s1", windowLabel: TERMINAL },
      },
      { label: TERMINAL, kind: "terminal" },
    );

    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    expect(mismatchWarnings()).toEqual([]);
    expect(tauriMock.state.relayedMessages).toEqual([]);
  });

  it("answers once when several subscribers see the same mismatched message", async () => {
    const handlers = await receive(
      MAIN,
      "content-handoff-return-requested",
      2,
      {
        content: { kind: "pty", id: "i1" },
        transferId: "t1",
        payload: { sessionId: "s1", windowLabel: TERMINAL },
      },
      { label: TERMINAL, kind: "terminal" },
      2,
    );

    await vi.waitFor(() =>
      expect(tauriMock.state.relayedMessages).toHaveLength(1),
    );
    await Promise.resolve();
    expect(tauriMock.state.relayedMessages).toHaveLength(1);
    expect(mismatchWarnings()).toHaveLength(1);
    for (const handler of handlers) expect(handler).not.toHaveBeenCalled();
  });

  it("warns but does not answer when the payload lacks the fields the failure needs", async () => {
    await receive(
      MAIN,
      "content-handoff-return-requested",
      2,
      {
        content: { kind: "pty" },
        transferId: null,
        payload: { sessionId: "s1", windowLabel: TERMINAL },
      },
      { label: TERMINAL, kind: "terminal" },
    );

    await vi.waitFor(() =>
      expect(
        warn.mock.calls.some((call) =>
          String(call[0]).startsWith("[protocol.version_mismatch_unanswered]"),
        ),
      ).toBe(true),
    );
    expect(tauriMock.state.relayedMessages).toEqual([]);
  });
});

describe("version mismatch reply table", () => {
  it("partitions every window message type and only answers in a valid direction without cycles", () => {
    const byType = Object.fromEntries(
      windowMessages.items.map((item) => [item.type, item]),
    );

    expect(Object.keys(VERSION_MISMATCH_REPLIES).sort()).toEqual(
      Object.keys(byType).sort(),
    );
    let replies = 0;
    for (const [type, reply] of Object.entries(VERSION_MISMATCH_REPLIES)) {
      if (!reply) continue;
      replies += 1;
      const original = byType[type];
      const failure = byType[reply.type];
      expect(failure, `${type} 的回送类型 ${reply.type} 未登记`).toBeDefined();
      expect(
        failure.from.some((kind) => original.to.includes(kind)),
        `${type}：回送方不在接收方类别内`,
      ).toBe(true);
      expect(
        failure.to.some((kind) => original.from.includes(kind)),
        `${type}：回送目标不在发送方类别内`,
      ).toBe(true);
      expect(
        VERSION_MISMATCH_REPLIES[reply.type],
        `${reply.type} 自身不能再回送`,
      ).toBeNull();
    }
    expect(replies).toBe(2);
  });
});

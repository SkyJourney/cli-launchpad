// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { tauriMock } from "../test/tauriMock";
import {
  INBOX_PENDING_LIMIT,
  onInboxEvent,
  REPLAY_MAX_AGE_MS,
} from "./windowInbox";

const TERMINAL = "terminal-8e783338-f464-4b10-b15e-b534748c6241";

function subscribeCalls() {
  return tauriMock.state.invokeCalls.filter(
    (call) => call.command === "subscribe_window_inbox",
  );
}

describe("window inbox", () => {
  it("subscribes once per window and dispatches by event name", async () => {
    tauriMock.setCurrentWindowLabel("main");
    const a = vi.fn();
    const b = vi.fn();

    await onInboxEvent("alpha", a);
    await onInboxEvent("beta", b);

    expect(subscribeCalls()).toHaveLength(1);
    expect(subscribeCalls()[0].windowLabel).toBe("main");
    tauriMock.deliverInbox("main", "alpha", { n: 1 });
    expect(a).toHaveBeenCalledTimes(1);
    expect(a.mock.calls[0][0]).toEqual({
      event: "alpha",
      payload: { n: 1 },
      seq: 1,
      source: null,
    });
    expect(b).not.toHaveBeenCalled();
    tauriMock.deliverInbox("main", "beta", 2);
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledTimes(1);
  });

  it("delivers to every handler of the event and isolates handler failures", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const last = vi.fn();
    await onInboxEvent("alpha", () => {
      throw new Error("boom");
    });
    await onInboxEvent("alpha", () => Promise.reject(new Error("rejected")));
    await onInboxEvent("alpha", last);

    expect(() => tauriMock.deliverInbox("main", "alpha", 1)).not.toThrow();

    expect(last).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledTimes(2));
    for (const call of errorSpy.mock.calls) {
      expect(String(call[0])).toContain("alpha");
    }
    errorSpy.mockRestore();
  });

  it("unlisten removes only that handler and keeps the subscription", async () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    const h3 = vi.fn();
    const stop1 = await onInboxEvent("alpha", h1);
    await onInboxEvent("alpha", h2);

    stop1();
    tauriMock.deliverInbox("main", "alpha", 1);

    expect(h1).not.toHaveBeenCalled();
    expect(h2).toHaveBeenCalledTimes(1);
    expect(subscribeCalls()).toHaveLength(1);
    await onInboxEvent("alpha", h3);
    expect(subscribeCalls()).toHaveLength(1);
  });

  it("retries the subscription after a failed attempt", async () => {
    tauriMock.failNextInboxSubscribe(new Error("subscribe failed"));
    const h = vi.fn();

    await expect(onInboxEvent("alpha", h)).rejects.toThrow("subscribe failed");

    expect(() => tauriMock.deliverInbox("main", "alpha", 1)).toThrow(
      /has no inbox subscription/,
    );
    await onInboxEvent("alpha", h);
    expect(subscribeCalls()).toHaveLength(2);
    tauriMock.deliverInbox("main", "alpha", 1);
    expect(h).toHaveBeenCalledTimes(1);
  });

  it("ignores messages nobody listens to and malformed messages", async () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const h = vi.fn();
    await onInboxEvent("alpha", h);
    const channel = tauriMock.state.inboxChannels.get("main");
    expect(channel).toBeDefined();

    expect(() => tauriMock.deliverInbox("main", "unknown", 1)).not.toThrow();
    expect(() => channel?.onmessage?.(null)).not.toThrow();
    expect(() => channel?.onmessage?.({ event: "alpha" })).not.toThrow();
    expect(() =>
      channel?.onmessage?.({
        seq: "1",
        event: "alpha",
        payload: 1,
        source: null,
      }),
    ).not.toThrow();

    expect(h).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(3);
    for (const call of warnSpy.mock.calls) {
      expect(call[0]).toBe("window_inbox.invalid_message");
    }
    tauriMock.deliverInbox("main", "alpha", 5);
    expect(h).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("passes the sequence number and the stamped source to handlers", async () => {
    const h = vi.fn();
    await onInboxEvent("alpha", h);
    const source = { label: TERMINAL, kind: "terminal" };

    tauriMock.deliverInbox("main", "alpha", 1);
    tauriMock.deliverInbox("main", "alpha", 2, source);

    expect(h.mock.calls[0][0].seq).toBe(1);
    expect(h.mock.calls[0][0].source).toBeNull();
    expect(h.mock.calls[1][0].seq).toBe(2);
    expect(h.mock.calls[1][0].source).toEqual(source);
  });

  it("replays only the newest exit request that arrived before its handler", async () => {
    tauriMock.queueInboxFlush("app-exit-requested", { requestId: "r1" });
    tauriMock.queueInboxFlush("app-exit-requested", { requestId: "r2" });
    // Another event's handler triggers the subscription; the exit request has no handler yet.
    const other = vi.fn();
    await onInboxEvent("execution-task-updated", other);
    expect(other).not.toHaveBeenCalled();

    const first = vi.fn();
    await onInboxEvent("app-exit-requested", first);

    expect(first.mock.calls.map((call) => call[0].payload)).toEqual([
      { requestId: "r2" },
    ]);
    // Reverse: the stash is consumed, so a handler registered afterwards gets nothing replayed.
    const second = vi.fn();
    await onInboxEvent("app-exit-requested", second);
    expect(second).not.toHaveBeenCalled();
    tauriMock.deliverInbox("main", "app-exit-requested", { requestId: "r3" });
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("replays to every handler registered at the same time, so an unmounted first one cannot swallow it", async () => {
    tauriMock.queueInboxFlush("workspace-data-restored", { n: 1 });
    await onInboxEvent("execution-task-updated", vi.fn());

    const unmounted = vi.fn();
    const mounted = vi.fn();
    // Both register before either subscription await resumes (a StrictMode remount).
    const [stopFirst] = await Promise.all([
      onInboxEvent("workspace-data-restored", unmounted),
      onInboxEvent("workspace-data-restored", mounted),
    ]);

    expect(unmounted).toHaveBeenCalledTimes(1);
    expect(mounted).toHaveBeenCalledTimes(1);
    stopFirst();
  });

  it("keeps the order when a live message arrives between registration and replay", async () => {
    tauriMock.queueInboxFlush("execution-task-updated", { n: 1 });
    await onInboxEvent("execution-task-log", vi.fn());
    const handler = vi.fn();

    const registration = onInboxEvent("execution-task-updated", handler);
    // The handler is registered but the replay has not run yet.
    tauriMock.deliverInbox("main", "execution-task-updated", { n: 2 });
    await registration;

    expect(handler.mock.calls.map((call) => call[0].payload)).toEqual([
      { n: 1 },
      { n: 2 },
    ]);
    // Once replayed, live messages are delivered directly again.
    tauriMock.deliverInbox("main", "execution-task-updated", { n: 3 });
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it("does not replay messages older than the replay window", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000_000);
    tauriMock.queueInboxFlush("app-exit-requested", { requestId: "old" });
    await onInboxEvent("execution-task-updated", vi.fn());

    now.mockReturnValue(1_000_000 + REPLAY_MAX_AGE_MS + 1);
    const handler = vi.fn();
    await onInboxEvent("app-exit-requested", handler);

    expect(handler).not.toHaveBeenCalled();
    now.mockRestore();
  });

  it("never replays events that carry timing or sender semantics", async () => {
    tauriMock.queueInboxFlush("pty-session-owner-lost", { sessionId: "s1" });
    tauriMock.queueInboxFlush("window-message", { type: "x" });
    tauriMock.queueInboxFlush("workspace-content-window-lost", { id: "w" });
    await onInboxEvent("execution-task-updated", vi.fn());

    const lost = vi.fn();
    const message = vi.fn();
    const contentLost = vi.fn();
    await onInboxEvent("pty-session-owner-lost", lost);
    await onInboxEvent("window-message", message);
    await onInboxEvent("workspace-content-window-lost", contentLost);

    expect(lost).not.toHaveBeenCalled();
    expect(message).not.toHaveBeenCalled();
    expect(contentLost).not.toHaveBeenCalled();
  });

  it("keeps only the newest stashed messages per event", async () => {
    for (let index = 1; index <= INBOX_PENDING_LIMIT + 5; index += 1) {
      tauriMock.queueInboxFlush("execution-task-log", { sequence: index });
    }
    await onInboxEvent("execution-task-updated", vi.fn());

    const handler = vi.fn();
    await onInboxEvent("execution-task-log", handler);

    expect(handler).toHaveBeenCalledTimes(INBOX_PENDING_LIMIT);
    expect(handler.mock.calls[0][0].payload).toEqual({ sequence: 6 });
    expect(handler.mock.calls[INBOX_PENDING_LIMIT - 1][0].payload).toEqual({
      sequence: INBOX_PENDING_LIMIT + 5,
    });
  });

  it("registers handlers before the subscription resolves so flushed messages are not lost", async () => {
    tauriMock.queueInboxFlush("alpha", "early");
    const h = vi.fn();

    await onInboxEvent("alpha", h);

    expect(h).toHaveBeenCalledTimes(1);
    expect(h.mock.calls[0][0]).toEqual({
      event: "alpha",
      payload: "early",
      seq: 1,
      source: null,
    });
    tauriMock.deliverInbox("main", "alpha", "late");
    expect(h).toHaveBeenCalledTimes(2);
    expect(h.mock.calls[1][0].seq).toBe(2);
    expect(h.mock.calls[1][0].payload).toBe("late");
    expect(subscribeCalls()).toHaveLength(1);
  });
});

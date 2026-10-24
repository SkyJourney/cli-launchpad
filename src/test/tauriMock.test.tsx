// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { emit, emitTo, listen } from "@tauri-apps/api/event";
import {
  getCurrentWebviewWindow,
  WebviewWindow,
} from "@tauri-apps/api/webviewWindow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { onInboxEvent } from "../lib/windowInbox";
import { tauriMock } from "./tauriMock";

const TERMINAL = "terminal-8e783338-f464-4b10-b15e-b534748c6241";
const WORKSPACE = "workspace-content-8e783338-f464-4b10-b15e-b534748c6241";

type ListenableWindow = {
  listen: (
    eventName: string,
    callback: (event: unknown) => void,
  ) => Promise<() => void>;
};

function captureThrown(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

afterEach(() => {
  cleanup();
});

describe("Tauri DOM test environment", () => {
  it("renders React and records invocations while allowing events to be triggered", async () => {
    const onEvent = vi.fn();
    await listen("contract-test-event", onEvent);

    render(
      <button onClick={() => void invoke("get_close_behavior", { id: 7 })}>
        Run command
      </button>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Run command" }));

    expect(tauriMock.state.invokeCalls).toEqual([
      {
        command: "get_close_behavior",
        args: { id: 7 },
        windowLabel: "main",
      },
    ]);

    tauriMock.emitEvent("contract-test-event", { ready: true }, "main");
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { ready: true } }),
    );
  });
});

describe("Tauri event target semantics", () => {
  it("delivers emitTo events to global Any listeners in every window", async () => {
    tauriMock.setCurrentWindowLabel(TERMINAL);
    const spy = vi.fn();
    await listen("probe", spy);
    // Child windows may no longer `emitTo`: the emitting window is main.
    tauriMock.setCurrentWindowLabel("main");

    await emitTo("main", "probe", { n: 1 });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { n: 1 } }),
    );
    expect(tauriMock.state.aclViolations).toEqual([]);
  });

  it("delivers emitTo events only to window-scoped listeners of the target label", async () => {
    tauriMock.setCurrentWindowLabel(TERMINAL);
    const spy = vi.fn();
    await getCurrentWebviewWindow().listen("probe", spy);
    // Child windows may no longer `emitTo`: the emitting window is main.
    tauriMock.setCurrentWindowLabel("main");

    await emitTo("main", "probe", { n: 1 });
    await emitTo(TERMINAL, "probe", { n: 2 });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { n: 2 } }),
    );
    expect(spy).not.toHaveBeenCalledWith(
      expect.objectContaining({ payload: { n: 1 } }),
    );
  });

  it("broadcasts emit to every listener", async () => {
    tauriMock.setCurrentWindowLabel("main");
    const anySpy = vi.fn();
    const windowSpy = vi.fn();
    await listen("probe", anySpy);
    await (tauriMock.getWindow(TERMINAL) as ListenableWindow).listen(
      "probe",
      windowSpy,
    );

    await emit("probe", {});

    expect(anySpy).toHaveBeenCalledTimes(1);
    expect(windowSpy).toHaveBeenCalledTimes(1);
    expect(anySpy.mock.calls[0][0].payload).toEqual({});
    expect(windowSpy.mock.calls[0][0].payload).toEqual({});
  });
});

describe("tauriMock capability enforcement", () => {
  it("rejects an app command that the window kind does not declare", async () => {
    tauriMock.setCurrentWindowLabel(TERMINAL);
    const handler = vi.fn(() => "ok");
    tauriMock.setInvokeHandler(handler);

    await expect(invoke("list_directories")).rejects.toEqual({
      code: "acl.denied",
      message: `list_directories not allowed for ${TERMINAL}`,
    });

    expect(tauriMock.state.aclViolations).toEqual([
      {
        windowLabel: TERMINAL,
        api: "invoke:list_directories",
        required: "app-command:list_directories",
      },
    ]);
    expect(handler).not.toHaveBeenCalled();
    expect(tauriMock.state.invokeCalls).toHaveLength(0);
  });

  it("allows declared app commands for terminal", async () => {
    tauriMock.setCurrentWindowLabel(TERMINAL);
    tauriMock.setInvokeHandler(() => "ok");

    await expect(invoke("write_pty_session", { sessionId: "s" })).resolves.toBe(
      "ok",
    );

    expect(tauriMock.state.aclViolations).toEqual([]);
    expect(tauriMock.state.invokeCalls).toHaveLength(1);
    expect(tauriMock.state.invokeCalls[0].windowLabel).toBe(TERMINAL);
  });

  it("allows every command on main", async () => {
    tauriMock.setInvokeHandler(() => "ok");

    await expect(invoke("list_directories")).resolves.toBe("ok");

    expect(tauriMock.state.aclViolations).toEqual([]);
  });

  it("exempts plugin commands from app-command checks", async () => {
    tauriMock.setCurrentWindowLabel(TERMINAL);
    tauriMock.setInvokeHandler(() => "clip");

    await expect(invoke("plugin:clipboard-manager|read_text")).resolves.toBe(
      "clip",
    );

    expect(tauriMock.state.aclViolations).toEqual([]);
    expect(tauriMock.state.invokeCalls[0].command).toBe(
      "plugin:clipboard-manager|read_text",
    );
  });

  it("rejects window actions missing from the capability", async () => {
    tauriMock.setCurrentWindowLabel(WORKSPACE);
    await expect(getCurrentWebviewWindow().setFocus()).rejects.toEqual({
      code: "acl.denied",
      message: `setFocus not allowed for ${WORKSPACE}`,
    });
    await expect(
      getCurrentWebviewWindow().setTheme("dark"),
    ).resolves.toBeUndefined();

    tauriMock.setCurrentWindowLabel("main");
    await expect(getCurrentWebviewWindow().setFocus()).resolves.toBeUndefined();

    expect(tauriMock.state.windowActions.map((a) => a.action)).toEqual([
      "setTheme",
      "setFocus",
    ]);
    expect(tauriMock.state.windowActions[0]).toEqual({
      windowLabel: WORKSPACE,
      callerLabel: WORKSPACE,
      action: "setTheme",
      args: ["dark"],
    });
    expect(tauriMock.state.aclViolations).toHaveLength(1);
    expect(tauriMock.state.aclViolations[0].api).toBe("setFocus");
  });

  it("rejects event APIs missing from the capability", async () => {
    tauriMock.setCurrentWindowLabel(TERMINAL);
    await expect(emit("probe", {})).rejects.toEqual({
      code: "acl.denied",
      message: `emit not allowed for ${TERMINAL}`,
    });
    await expect(emitTo("main", "probe", {})).rejects.toEqual({
      code: "acl.denied",
      message: `emitTo not allowed for ${TERMINAL}`,
    });

    tauriMock.setCurrentWindowLabel(WORKSPACE);
    await expect(emitTo("main", "probe", {})).rejects.toEqual({
      code: "acl.denied",
      message: `emitTo not allowed for ${WORKSPACE}`,
    });

    tauriMock.setCurrentWindowLabel("main");
    await expect(emit("probe", {})).resolves.toBeUndefined();

    expect(tauriMock.state.emittedEvents).toHaveLength(1);
    expect(tauriMock.state.emittedEvents.map((e) => e.windowLabel)).toEqual([
      "main",
    ]);
    expect(tauriMock.state.aclViolations).toHaveLength(3);
    expect(tauriMock.state.aclViolations.map((v) => v.api)).toEqual([
      "emit",
      "emitTo",
      "emitTo",
    ]);
  });

  it("rejects creating and looking up windows from child windows", async () => {
    tauriMock.setCurrentWindowLabel(TERMINAL);
    const thrown = captureThrown(() => new WebviewWindow(WORKSPACE, {}));
    expect(thrown).toEqual({
      code: "acl.denied",
      message: `createWebviewWindow not allowed for ${TERMINAL}`,
    });
    expect(tauriMock.state.createdWindows).toHaveLength(0);
    await expect(WebviewWindow.getByLabel(WORKSPACE)).rejects.toEqual({
      code: "acl.denied",
      message: `getByLabel not allowed for ${TERMINAL}`,
    });

    tauriMock.setCurrentWindowLabel("main");
    expect(() => new WebviewWindow(WORKSPACE, {})).not.toThrow();
    expect(tauriMock.state.createdWindows).toHaveLength(1);
    await expect(WebviewWindow.getByLabel(WORKSPACE)).resolves.not.toBeNull();

    expect(tauriMock.state.aclViolations).toHaveLength(2);
  });

  it("throws for unknown window labels", async () => {
    tauriMock.setCurrentWindowLabel("workspace-content-test");

    await expect(invoke("x")).rejects.toThrow(
      "tauriMock: unknown window label workspace-content-test",
    );
    await expect(listen("probe", vi.fn())).rejects.toThrow(
      "tauriMock: unknown window label workspace-content-test",
    );

    expect(tauriMock.state.aclViolations).toEqual([]);
    expect(tauriMock.state.invokeCalls).toHaveLength(0);
  });

  it("disables checks with setEnforceCapabilities(false) and re-enables on reset", async () => {
    tauriMock.setCurrentWindowLabel(TERMINAL);
    tauriMock.setInvokeHandler(() => "ok");

    tauriMock.setEnforceCapabilities(false);
    await expect(invoke("list_directories")).resolves.toBe("ok");
    expect(tauriMock.state.aclViolations).toEqual([]);

    tauriMock.reset();
    tauriMock.setCurrentWindowLabel(TERMINAL);
    tauriMock.setInvokeHandler(() => "ok");
    await expect(invoke("list_directories")).rejects.toMatchObject({
      code: "acl.denied",
    });
  });
});

describe("tauriMock records and helpers", () => {
  it("records the calling window on invokes, emitted events and window actions", async () => {
    tauriMock.setCurrentWindowLabel(TERMINAL);
    tauriMock.setInvokeHandler(() => undefined);

    await invoke("get_pty_session_window_status", { sessionId: "s" });
    // Child windows may no longer `emitTo`: the emitting window is main.
    tauriMock.setCurrentWindowLabel("main");
    await emitTo("main", "probe", { n: 1 });
    tauriMock.setCurrentWindowLabel(TERMINAL);
    await getCurrentWebviewWindow().setTheme("dark");

    expect(tauriMock.state.invokeCalls[0]).toEqual({
      command: "get_pty_session_window_status",
      args: { sessionId: "s" },
      windowLabel: TERMINAL,
    });
    expect(tauriMock.state.emittedEvents[0]).toEqual({
      windowLabel: "main",
      target: "main",
      eventName: "probe",
      payload: { n: 1 },
    });
    expect(tauriMock.state.windowActions[0]).toEqual({
      windowLabel: TERMINAL,
      callerLabel: TERMINAL,
      action: "setTheme",
      args: ["dark"],
    });
    expect(tauriMock.state.aclViolations).toEqual([]);
  });

  it("failNextListen rejects only the next listen of that event", async () => {
    tauriMock.failNextListen("probe", { code: "listen.failed" });
    await expect(listen("probe", vi.fn())).rejects.toEqual({
      code: "listen.failed",
    });
    await expect(listen("probe", vi.fn())).resolves.toBeTypeOf("function");

    tauriMock.failNextListen("probe", { code: "listen.failed" });
    await expect(listen("other", vi.fn())).resolves.toBeTypeOf("function");
    await expect(listen("probe", vi.fn())).rejects.toEqual({
      code: "listen.failed",
    });
  });

  it("destroyWindow delivers tauri://destroyed to that window's listeners and forgets the window", async () => {
    tauriMock.setCurrentWindowLabel(TERMINAL);
    const windowSpy = vi.fn();
    const anySpy = vi.fn();
    await getCurrentWebviewWindow().listen("tauri://destroyed", windowSpy);
    await listen("tauri://destroyed", anySpy);
    expect(tauriMock.state.windows.has(TERMINAL)).toBe(true);

    tauriMock.destroyWindow(TERMINAL);

    expect(windowSpy).toHaveBeenCalledTimes(1);
    expect(tauriMock.state.windows.has(TERMINAL)).toBe(false);
    expect(anySpy).not.toHaveBeenCalled();
    expect(tauriMock.state.eventListeners).toHaveLength(2);
  });

  it("reset clears listeners, violations and pending listen failures", async () => {
    await listen("probe", vi.fn());
    tauriMock.failNextListen("later", { code: "x" });
    tauriMock.setCurrentWindowLabel(TERMINAL);
    await expect(invoke("list_directories")).rejects.toMatchObject({
      code: "acl.denied",
    });

    tauriMock.reset();

    expect(tauriMock.state.eventListeners).toHaveLength(0);
    expect(tauriMock.state.aclViolations).toHaveLength(0);
    await expect(listen("later", vi.fn())).resolves.toBeTypeOf("function");
    expect(tauriMock.state.invokeCalls).toHaveLength(0);
  });

  it("delivers inbox messages only to the channel of the addressed window", async () => {
    tauriMock.setCurrentWindowLabel("main");
    const channel = new Channel<unknown>();
    const got: unknown[] = [];
    channel.onmessage = (message) => got.push(message);
    await invoke("subscribe_window_inbox", { onEvent: channel });

    tauriMock.deliverInbox("main", "probe", { n: 1 });
    tauriMock.deliverInbox("main", "probe", { n: 2 });

    expect(got).toEqual([
      { seq: 1, event: "probe", payload: { n: 1 }, source: null },
      { seq: 2, event: "probe", payload: { n: 2 }, source: null },
    ]);
    expect(() => tauriMock.deliverInbox(WORKSPACE, "probe", 1)).toThrow(
      `tauriMock: window ${WORKSPACE} has no inbox subscription`,
    );
    expect(tauriMock.state.aclViolations).toEqual([]);
  });

  it("fails the next inbox subscriptions on request and then recovers", async () => {
    tauriMock.failNextInboxSubscribe({ code: "x" }, 2);

    await expect(
      invoke("subscribe_window_inbox", { onEvent: new Channel() }),
    ).rejects.toEqual({ code: "x" });
    await expect(
      invoke("subscribe_window_inbox", { onEvent: new Channel() }),
    ).rejects.toEqual({ code: "x" });
    const result = await invoke("subscribe_window_inbox", {
      onEvent: new Channel(),
    });

    expect(result).toEqual({ replaced: false, flushed: 0, dropped: 0 });
    expect(
      tauriMock.state.invokeCalls.filter(
        (call) => call.command === "subscribe_window_inbox",
      ),
    ).toHaveLength(3);
  });

  it("reset clears inbox subscriptions and pending subscription failures", async () => {
    await invoke("subscribe_window_inbox", { onEvent: new Channel() });
    tauriMock.failNextInboxSubscribe({ code: "later" });
    tauriMock.queueInboxFlush("probe", 1);

    tauriMock.reset();

    expect(tauriMock.state.inboxChannels.size).toBe(0);
    const result = await invoke("subscribe_window_inbox", {
      onEvent: new Channel(),
    });
    expect(result).toEqual({ replaced: false, flushed: 0, dropped: 0 });
    tauriMock.deliverInbox("main", "probe", 1);
    // Sequence numbers start over after a reset.
    tauriMock.reset();
    const seen = vi.fn();
    // The module state of the inbox is cleared too: a new handler subscribes again.
    await onInboxEvent("alpha", seen);
    tauriMock.deliverInbox("main", "alpha", 1);
    expect(seen.mock.calls[0][0].seq).toBe(1);
    expect(
      tauriMock.state.invokeCalls.filter(
        (call) => call.command === "subscribe_window_inbox",
      ),
    ).toHaveLength(1);
  });

  it("relays send_window_message to the inbox of the target with the caller as source", async () => {
    tauriMock.setCurrentWindowLabel(TERMINAL);
    const got: unknown[] = [];
    const channel = new Channel<unknown>();
    channel.onmessage = (message) => got.push(message);
    await invoke("subscribe_window_inbox", { onEvent: channel });
    tauriMock.setCurrentWindowLabel("main");

    await expect(
      invoke("send_window_message", {
        target: TERMINAL,
        messageType: "pty-return-complete",
        payload: {
          apiVersion: 1,
          type: "pty-return-complete",
          payload: {},
        },
      }),
    ).resolves.toEqual({ delivered: true });

    expect(got).toEqual([
      {
        seq: 1,
        event: "window-message",
        payload: {
          apiVersion: 1,
          type: "pty-return-complete",
          payload: {},
        },
        source: { label: "main", kind: "main" },
      },
    ]);
    expect(tauriMock.state.aclViolations).toEqual([]);
  });

  it("records relayed messages as window-message events and reports unavailable targets", async () => {
    tauriMock.setCurrentWindowLabel(TERMINAL);
    const envelope = {
      apiVersion: 1,
      type: "pty-detached-ready",
      payload: {},
    };

    await expect(
      invoke("send_window_message", {
        target: "main",
        messageType: "pty-detached-ready",
        payload: envelope,
      }),
    ).resolves.toEqual({ delivered: false });

    expect(tauriMock.state.relayedMessages).toEqual([
      {
        from: TERMINAL,
        target: "main",
        messageType: "pty-detached-ready",
        payload: envelope,
      },
    ]);
    expect(
      tauriMock.state.emittedEvents.filter(
        (event) =>
          event.eventName === "window-message" &&
          event.target === "main" &&
          event.windowLabel === TERMINAL,
      ),
    ).toEqual([
      {
        windowLabel: TERMINAL,
        target: "main",
        eventName: "window-message",
        payload: envelope,
      },
    ]);
    expect(tauriMock.state.aclViolations).toEqual([]);
  });
});

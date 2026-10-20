import { describe, expect, it, vi } from "vitest";
import { listen } from "@tauri-apps/api/event";
import { tauriMock } from "../test/tauriMock";
import { onContentHandoff } from "./workspaceContentWindowProtocol";
import { toGenericMessage } from "../test/host/handoffVocabulary";

const TERMINAL_A = "terminal-8e783338-f464-4b10-b15e-b534748c6241";
const TERMINAL_B = "terminal-3b9f2c1e-6d4a-4f7b-8a21-5c0e9d7a1b34";

describe("workspace content window protocol with the global Tauri mock", () => {
  it("delivers messages only to the inbox of the addressed window", async () => {
    const payload = {
      instanceId: "slot-1",
      sessionId: "session-1",
      windowLabel: TERMINAL_A,
    };
    tauriMock.setCurrentWindowLabel(TERMINAL_A);
    const readyA = vi.fn();
    const stopA = await onContentHandoff("pty", "ready", readyA);
    tauriMock.setCurrentWindowLabel(TERMINAL_B);
    const readyB = vi.fn();
    const stopB = await onContentHandoff("pty", "ready", readyB);
    const generic = toGenericMessage("pty-detached-ready", payload);
    const message = {
      apiVersion: 1,
      type: generic.type,
      payload: generic.payload,
    };
    const stamped = { label: TERMINAL_A, kind: "terminal" };
    try {
      tauriMock.deliverInbox(TERMINAL_B, "window-message", message, stamped);
      expect(readyB).toHaveBeenCalledTimes(1);
      expect(readyA).not.toHaveBeenCalled();

      tauriMock.deliverInbox(TERMINAL_A, "window-message", message, stamped);
      expect(readyA).toHaveBeenCalledTimes(1);
      expect(readyA.mock.calls[0][0].payload).toEqual(payload);
      // The message never travels as a Tauri event: no listener is registered for it.
      expect(
        tauriMock.state.eventListeners.some(
          (item) => item.eventName === "window-message",
        ),
      ).toBe(false);
      expect(listen).not.toHaveBeenCalled();
    } finally {
      stopA();
      stopB();
    }
  });

  it("keeps one inbox subscription per window and stops delivering after unlisten", async () => {
    tauriMock.setCurrentWindowLabel("main");
    const ready = vi.fn();
    const failed = vi.fn();
    const stopReady = await onContentHandoff("pty", "ready", ready);
    const stopFailed = await onContentHandoff("pty", "failed", failed);
    const subscriptions = () =>
      tauriMock.state.invokeCalls.filter(
        (call) => call.command === "subscribe_window_inbox",
      );
    try {
      expect(subscriptions()).toHaveLength(1);

      stopReady();
      expect(subscriptions()).toHaveLength(1);
      const generic = toGenericMessage("pty-detached-ready", {
        instanceId: "slot-1",
        sessionId: "session-1",
        windowLabel: TERMINAL_A,
      });
      tauriMock.deliverInbox(
        "main",
        "window-message",
        { apiVersion: 1, type: generic.type, payload: generic.payload },
        { label: TERMINAL_A, kind: "terminal" },
      );
      expect(ready).not.toHaveBeenCalled();
    } finally {
      stopReady();
      stopFailed();
    }
    // Nothing is left in the global event registry.
    expect(tauriMock.state.eventListeners).toHaveLength(0);
    expect(listen).not.toHaveBeenCalled();
  });
});

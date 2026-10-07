import { describe, expect, it, vi } from "vitest";
import { listen } from "@tauri-apps/api/event";
import { tauriMock } from "../test/tauriMock";
import {
  emitWorkspaceContentWindowEvent,
  listenWorkspaceContentWindowEvent,
  WORKSPACE_CONTENT_WINDOW_EVENT,
} from "./workspaceContentWindowProtocol";

describe("workspace content window protocol with the global Tauri mock", () => {
  it("subscribes per window and ignores emits addressed to other windows", async () => {
    const label = "terminal-8e783338-f464-4b10-b15e-b534748c6241";
    tauriMock.setCurrentWindowLabel(label);
    const ready = vi.fn();
    const payload = {
      instanceId: "slot-1",
      sessionId: "session-1",
      windowLabel: label,
    };

    const stop = await listenWorkspaceContentWindowEvent(
      "pty-detached-ready",
      ready,
    );
    try {
      await emitWorkspaceContentWindowEvent(
        "terminal-other",
        "pty-detached-ready",
        payload,
      );
      expect(ready).not.toHaveBeenCalled();

      await emitWorkspaceContentWindowEvent(
        label,
        "pty-detached-ready",
        payload,
      );
      expect(ready).toHaveBeenCalledTimes(1);
      expect(ready).toHaveBeenCalledWith({ payload });
      expect(listen).not.toHaveBeenCalled();
      expect(tauriMock.getWindow(label).listen).toHaveBeenCalledTimes(1);
    } finally {
      // 协议模块持有进程内的订阅状态：断言失败时也必须释放，否则会污染后续用例。
      stop();
    }
  });

  it("releases the window-scoped listener when the last subscriber stops", async () => {
    tauriMock.setCurrentWindowLabel("main");
    const protocolListeners = () =>
      tauriMock.state.eventListeners.filter(
        (item) => item.eventName === WORKSPACE_CONTENT_WINDOW_EVENT,
      );

    const stopReady = await listenWorkspaceContentWindowEvent(
      "pty-detached-ready",
      vi.fn(),
    );
    const stopFailed = await listenWorkspaceContentWindowEvent(
      "pty-detached-failed",
      vi.fn(),
    );
    try {
      expect(protocolListeners()).toHaveLength(1);

      stopReady();
      expect(protocolListeners()).toHaveLength(1);
    } finally {
      stopReady();
      stopFailed();
    }
    expect(protocolListeners()).toHaveLength(0);
    expect(listen).not.toHaveBeenCalled();
  });
});

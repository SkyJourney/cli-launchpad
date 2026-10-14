// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const log = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("./protocolHandlers.pty", () => ({
  startPtyListeners: vi.fn(() => {
    log.calls.push("start:pty");
    return () => {
      log.calls.push("stop:pty");
    };
  }),
}));
vi.mock("./protocolHandlers.file", () => ({
  startFileListeners: vi.fn(() => {
    log.calls.push("start:file");
    return () => {
      log.calls.push("stop:file");
    };
  }),
  startWindowLostListeners: vi.fn(() => {
    log.calls.push("start:lost");
    return () => {
      log.calls.push("stop:lost");
    };
  }),
}));

import { startPtyListeners } from "./protocolHandlers.pty";
import {
  startFileListeners,
  startWindowLostListeners,
} from "./protocolHandlers.file";
import type { ProtocolListenerShell } from "./contentWindowOrchestrator";
import type { FileProtocolHandlers } from "./protocolHandlers.file";
import type { PtyProtocolHandlers } from "./protocolHandlers.pty";
import {
  createContentWindowProtocol,
  useContentWindowProtocol,
} from "./useContentWindowProtocol";

afterEach(() => {
  log.calls.length = 0;
  cleanup();
});

describe("useContentWindowProtocol", () => {
  it("starts the protocol once and stops it on unmount", () => {
    const stop = vi.fn();
    const protocol = { start: vi.fn(() => stop) };
    const view = renderHook(({ p }) => useContentWindowProtocol(p), {
      initialProps: { p: protocol },
    });

    expect(protocol.start).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();

    view.rerender({ p: protocol });
    view.rerender({ p: protocol });
    expect(protocol.start).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();

    view.unmount();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(protocol.start).toHaveBeenCalledTimes(1);
  });

  it("restarts only when the protocol object changes", () => {
    const stopA = vi.fn();
    const stopB = vi.fn();
    const protocolA = { start: vi.fn(() => stopA) };
    const protocolB = { start: vi.fn(() => stopB) };
    const view = renderHook(({ p }) => useContentWindowProtocol(p), {
      initialProps: { p: protocolA },
    });

    view.rerender({ p: protocolB });
    expect(stopA).toHaveBeenCalledTimes(1);
    expect(protocolA.start).toHaveBeenCalledTimes(1);
    expect(protocolB.start).toHaveBeenCalledTimes(1);
    expect(stopB).not.toHaveBeenCalled();

    view.rerender({ p: protocolB });
    expect(stopA).toHaveBeenCalledTimes(1);
    expect(protocolA.start).toHaveBeenCalledTimes(1);
    expect(protocolB.start).toHaveBeenCalledTimes(1);
    expect(stopB).not.toHaveBeenCalled();

    view.unmount();
    expect(stopB).toHaveBeenCalledTimes(1);
    expect(stopA).toHaveBeenCalledTimes(1);
  });

  it("createContentWindowProtocol starts the pty, lost and file listener groups in host order and stops them together", () => {
    const pty = { group: "pty" } as unknown as PtyProtocolHandlers;
    const file = { group: "file" } as unknown as FileProtocolHandlers;
    const shell: ProtocolListenerShell = {
      retryDelaysMs: [] as readonly number[],
      onFailed: vi.fn(),
    };
    const protocol = createContentWindowProtocol({ pty, file, shell });
    expect(log.calls).toEqual([]);

    const stop = protocol.start();

    expect(log.calls).toEqual(["start:pty", "start:lost", "start:file"]);
    expect(startPtyListeners).toHaveBeenCalledTimes(1);
    const ptyCall = vi.mocked(startPtyListeners).mock.calls[0];
    expect(ptyCall[0]).toBe(pty);
    expect(ptyCall[1]).toBe(shell);
    const lostCall = vi.mocked(startWindowLostListeners).mock.calls[0];
    expect(lostCall[0]).toBe(file);
    expect(lostCall[1]).toBe(shell);
    const fileCall = vi.mocked(startFileListeners).mock.calls[0];
    expect(fileCall[0]).toBe(file);
    expect(fileCall[1]).toBe(shell);

    stop();
    expect(log.calls).toEqual([
      "start:pty",
      "start:lost",
      "start:file",
      "stop:pty",
      "stop:lost",
      "stop:file",
    ]);
    expect(shell.onFailed).not.toHaveBeenCalled();
  });
});

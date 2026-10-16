// @vitest-environment jsdom
import type { TFunction } from "i18next";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "react-i18next",
  async () => (await import("../../test/host/hostMocks")).reactI18nextMock,
);

import { tauriMock } from "../../test/tauriMock";
import { WorkspaceContentCoordinator } from "../../lib/workspaceContentCoordinator";
import {
  createInitialHostSnapshot,
  WorkspaceHostStore,
} from "../host/workspaceHostStore";
import {
  createContentWindowOrchestrator,
  type ProtocolListenerShell,
} from "./contentWindowOrchestrator";
import {
  createFileProtocolHandlers,
  startFileListeners,
  startWindowLostListeners,
} from "./protocolHandlers.file";
import {
  createPtyProtocolHandlers,
  startPtyListeners,
} from "./protocolHandlers.pty";

function flush() {
  // 有上限的微任务循环：不依赖真实时间。
  return (async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  })();
}

function listenersNamed(name: string) {
  // Rust notifications are handlers of the main window's inbox (m6-061), not `listen` records;
  // one entry per registered handler keeps the length assertions below unchanged.
  return Array.from({ length: tauriMock.inboxHandlerCount("main", name) });
}

function makeProtocolFixture() {
  const store = new WorkspaceHostStore(createInitialHostSnapshot("pane-1"));
  const coordinator = new WorkspaceContentCoordinator();
  const translate = ((key: string) => key) as unknown as TFunction;
  const orchestrator = createContentWindowOrchestrator({
    store,
    getCoordinator: () => coordinator,
    translate,
    commitTree: (next) =>
      store.commit((live) => ({ ...live, tree: next }), "test:commitTree"),
    setFocusedPane: (paneId) =>
      store.commit(
        (live) => ({ ...live, focusedPaneId: paneId }),
        "test:focus",
      ),
    removeSlot: vi.fn(),
    loadFile: vi.fn(async () => undefined),
    waitForFileSave: vi.fn(async () => undefined),
    mergeFileBuffers: vi.fn(),
    terminalOf: () => undefined,
    titleOfPty: () => "title",
    openDirectory: vi.fn(),
  });
  const shell: ProtocolListenerShell = {
    retryDelaysMs: [],
    onFailed: vi.fn(),
  };
  return { orchestrator, shell };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("protocol handlers", () => {
  it("PTY protocol group registers its five events in order and removes its listeners on stop", async () => {
    const f = makeProtocolFixture();
    const handlers = createPtyProtocolHandlers(f.orchestrator);
    const ownerLost = () => listenersNamed("pty-session-owner-lost");

    expect(handlers.registrations().map((r) => r.name)).toEqual([
      "pty-detached-ready",
      "pty-detached-failed",
      "pty-session-owner-lost",
      "pty-return-requested",
      "pty-detached-exited",
    ]);
    expect(ownerLost()).toHaveLength(0);

    const stop = startPtyListeners(handlers, f.shell);
    await flush();
    expect(ownerLost()).toHaveLength(1);

    stop();
    await flush();
    expect(ownerLost()).toHaveLength(0);
    expect(f.shell.onFailed).not.toHaveBeenCalled();
    expect(listenersNamed("workspace-content-window-lost")).toHaveLength(0);
  });

  it("file and lost protocol groups register their events and remove their listeners on stop", async () => {
    const f = makeProtocolFixture();
    const handlers = createFileProtocolHandlers(f.orchestrator);
    const lost = () => listenersNamed("workspace-content-window-lost");

    expect(handlers.registrations().map((r) => r.name)).toEqual([
      "workspace-file-window-ready",
      "workspace-file-window-attached",
      "workspace-file-window-attach-failed",
      "workspace-file-window-buffer-changed",
      "workspace-file-window-return-requested",
    ]);
    expect(handlers.lostRegistrations().map((r) => r.name)).toEqual([
      "workspace-content-window-lost",
    ]);
    expect(lost()).toHaveLength(0);

    const stopLost = startWindowLostListeners(handlers, f.shell);
    await flush();
    expect(lost()).toHaveLength(1);
    stopLost();
    await flush();
    expect(lost()).toHaveLength(0);

    const stopFile = startFileListeners(handlers, f.shell);
    await flush();
    stopFile();
    await flush();

    expect(f.shell.onFailed).not.toHaveBeenCalled();
    expect(listenersNamed("pty-session-owner-lost")).toHaveLength(0);
  });

  it("stopping before registrations settle leaves no listener behind", async () => {
    const f = makeProtocolFixture();
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const ptyHandlers = createPtyProtocolHandlers(f.orchestrator);
    const fileHandlers = createFileProtocolHandlers(f.orchestrator);

    startPtyListeners(ptyHandlers, f.shell)();
    startWindowLostListeners(fileHandlers, f.shell)();
    startFileListeners(fileHandlers, f.shell)();
    await flush();

    expect(listenersNamed("pty-session-owner-lost")).toHaveLength(0);
    expect(listenersNamed("workspace-content-window-lost")).toHaveLength(0);
    expect(f.shell.onFailed).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

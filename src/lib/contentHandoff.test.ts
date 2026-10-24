// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { tauriMock } from "../test/tauriMock";
import { onInboxEvent } from "./windowInbox";
import {
  CONTENT_HANDOFF_MESSAGE_TYPES,
  CONTENT_HANDOFF_PHASES,
  decodeContentHandoff,
  encodeContentHandoff,
  onContentHandoff,
  sendContentHandoff,
} from "./workspaceContentWindowProtocol";

const MAIN = "main";
const TERMINAL = "terminal-8e783338-f464-4b10-b15e-b534748c6241";
const CONTENT = "workspace-content-8e783338-f464-4b10-b15e-b534748c6241";
const OTHER_CONTENT = "workspace-content-3b9f2c1e-6d4a-4f7b-8a21-5c0e9d7a1b34";

const fileDocument = {
  id: "d1",
  directoryId: 1,
  directoryPath: "C:/Projects/demo",
  relativePath: "src/a.ts",
};
const fileBuffer = {
  epoch: 2,
  version: 1,
  content: "hello",
  savedContent: "hello",
  revision: "r1",
  saving: false,
  kind: "text" as const,
};

/** Invoke calls of one command, read from the mock state (no harness helper). */
function invokesOf(command: string) {
  return tauriMock.state.invokeCalls.filter((call) => call.command === command);
}

afterEach(() => {
  vi.restoreAllMocks();
  tauriMock.reset();
});

describe("content handoff wire encoding", () => {
  it("CH-1 encodes the content identity and the transfer token out of the per-kind payload", () => {
    expect(
      encodeContentHandoff("pty", {
        instanceId: "i1",
        sessionId: "s1",
        windowLabel: "terminal-a",
      }),
    ).toEqual({
      content: { kind: "pty", id: "i1" },
      transferId: null,
      payload: { sessionId: "s1", windowLabel: "terminal-a" },
    });
    expect(
      encodeContentHandoff("pty", {
        instanceId: "i1",
        sessionId: "s1",
        windowLabel: "terminal-a",
        token: "t1",
        targetPaneId: "p1",
      }),
    ).toEqual({
      content: { kind: "pty", id: "i1" },
      transferId: "t1",
      payload: {
        sessionId: "s1",
        windowLabel: "terminal-a",
        targetPaneId: "p1",
      },
    });
    const withoutToken = encodeContentHandoff("pty", {
      instanceId: "i1",
      targetPaneId: "p1",
    });
    expect(withoutToken.transferId).toBeNull();
    expect(withoutToken.payload).toEqual({ targetPaneId: "p1" });
    expect(
      encodeContentHandoff("file", {
        documentId: "d1",
        token: "t2",
        windowLabel: "workspace-content-a",
      }),
    ).toEqual({
      content: { kind: "file", id: "d1" },
      transferId: "t2",
      payload: { windowLabel: "workspace-content-a" },
    });
    const withBuffers = encodeContentHandoff("file", {
      documentId: "d1",
      fileDocument,
      fileBuffer,
      requestId: "r1",
    });
    expect(withBuffers.payload).toEqual({
      fileDocument,
      fileBuffer,
      requestId: "r1",
    });
    // Reverse: a missing identity or an empty one is refused; a missing token is null, not undefined.
    expect(() => encodeContentHandoff("file", { token: "t" })).toThrow(
      /documentId/,
    );
    expect(() => encodeContentHandoff("pty", { instanceId: "" })).toThrow();
    expect(
      encodeContentHandoff("pty", { instanceId: "i1" }).transferId,
    ).toBeNull();
  });

  it("CH-2 decodes the generic envelope back into the per-kind payload and rejects smuggled identity fields", () => {
    expect(
      decodeContentHandoff("pty", {
        content: { kind: "pty", id: "i1" },
        transferId: null,
        payload: { sessionId: "s1", windowLabel: "terminal-a" },
      }),
    ).toEqual({ sessionId: "s1", windowLabel: "terminal-a", instanceId: "i1" });
    expect(
      decodeContentHandoff("pty", {
        content: { kind: "pty", id: "i1" },
        transferId: "t1",
        payload: {
          sessionId: "s1",
          windowLabel: "terminal-a",
          targetPaneId: "p1",
        },
      }),
    ).toEqual({
      sessionId: "s1",
      windowLabel: "terminal-a",
      targetPaneId: "p1",
      instanceId: "i1",
      token: "t1",
    });
    expect(
      decodeContentHandoff("file", {
        content: { kind: "file", id: "d1" },
        transferId: "t2",
        payload: { windowLabel: "workspace-content-a" },
      }),
    ).toEqual({
      windowLabel: "workspace-content-a",
      documentId: "d1",
      token: "t2",
    });

    const validFile = {
      content: { kind: "file", id: "d1" },
      transferId: null,
      payload: {},
    };
    // Reverse: every malformed shape decodes to null.
    expect(decodeContentHandoff("pty", validFile)).toBeNull();
    expect(
      decodeContentHandoff("pty", {
        content: { kind: "pty", id: "" },
        transferId: null,
        payload: {},
      }),
    ).toBeNull();
    expect(
      decodeContentHandoff("pty", {
        content: { kind: "pty", id: "i1" },
        transferId: 5,
        payload: {},
      }),
    ).toBeNull();
    expect(
      decodeContentHandoff("pty", {
        content: { kind: "pty", id: "i1" },
        transferId: null,
        payload: { instanceId: "other" },
      }),
    ).toBeNull();
    expect(
      decodeContentHandoff("pty", {
        content: { kind: "pty", id: "i1" },
        transferId: null,
        payload: { token: "smuggled" },
      }),
    ).toBeNull();
    expect(
      decodeContentHandoff("pty", {
        content: { kind: "pty", id: "i1" },
        transferId: null,
        payload: [],
      }),
    ).toBeNull();
    expect(decodeContentHandoff("pty", null)).toBeNull();
    expect(
      decodeContentHandoff("pty", { transferId: null, payload: {} }),
    ).toBeNull();
  });

  it("CH-3b reports an empty content id as a rejected promise, never as a synchronous throw", async () => {
    let thrown: unknown = null;
    let pending: Promise<void> | undefined;
    try {
      pending = sendContentHandoff(TERMINAL, "pty", "return-complete", {
        instanceId: "",
        token: "t1",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeNull();
    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).rejects.toThrow(
      "Content handoff payload has no instanceId",
    );
    expect(invokesOf("send_window_message")).toHaveLength(0);
  });

  it("CH-3 sends the generic message type with an encoded envelope through the relay command", async () => {
    tauriMock.setCurrentWindowLabel(TERMINAL);
    await onInboxEvent("window-message", vi.fn());
    tauriMock.setCurrentWindowLabel(CONTENT);
    await onInboxEvent("window-message", vi.fn());
    tauriMock.setCurrentWindowLabel(MAIN);

    await sendContentHandoff(TERMINAL, "pty", "return-complete", {
      instanceId: "i1",
      token: "t1",
    });
    expect(invokesOf("send_window_message")[0].args).toEqual({
      target: TERMINAL,
      messageType: "content-handoff-return-complete",
      payload: {
        apiVersion: 1,
        type: "content-handoff-return-complete",
        payload: {
          content: { kind: "pty", id: "i1" },
          transferId: "t1",
          payload: {},
        },
      },
    });

    await sendContentHandoff(CONTENT, "file", "init", {
      documentId: "d1",
      token: "t2",
      windowLabel: CONTENT,
      fileDocument,
      fileBuffer,
    });
    expect(invokesOf("send_window_message")[1].args).toEqual({
      target: CONTENT,
      messageType: "content-handoff-init",
      payload: {
        apiVersion: 1,
        type: "content-handoff-init",
        payload: {
          content: { kind: "file", id: "d1" },
          transferId: "t2",
          payload: { windowLabel: CONTENT, fileDocument, fileBuffer },
        },
      },
    });

    // Reverse: no legacy event name is emitted, every relayed type is generic, and an unavailable
    // target only warns.
    expect(
      tauriMock.state.emittedEvents.some(
        (event) => event.eventName === "workspace-content-window-event",
      ),
    ).toBe(false);
    expect(
      invokesOf("send_window_message").every((call) =>
        String((call.args as { messageType: string }).messageType).startsWith(
          "content-handoff-",
        ),
      ),
    ).toBe(true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      sendContentHandoff(OTHER_CONTENT, "file", "return-failed", {
        documentId: "d9",
        token: "t9",
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "window_message.target_unavailable",
      "content-handoff-return-failed",
    );
  });
});

describe("content handoff delivery", () => {
  it("CH-4 delivers a message only to handlers of the same kind and phase", async () => {
    tauriMock.setCurrentWindowLabel(MAIN);
    const hp = vi.fn();
    const hf = vi.fn();
    const ha = vi.fn();
    await onContentHandoff("pty", "ready", hp);
    await onContentHandoff("file", "ready", hf);
    await onContentHandoff("file", "attached", ha);

    tauriMock.deliverInbox(
      MAIN,
      "window-message",
      {
        apiVersion: 1,
        type: "content-handoff-ready",
        payload: {
          content: { kind: "file", id: "d1" },
          transferId: "t2",
          payload: { windowLabel: CONTENT },
        },
      },
      { label: CONTENT, kind: "workspaceContent" },
    );
    expect(hf).toHaveBeenCalledTimes(1);
    expect(hf).toHaveBeenCalledWith({
      payload: { documentId: "d1", token: "t2", windowLabel: CONTENT },
      source: { label: CONTENT, kind: "workspaceContent" },
    });
    expect(hp).toHaveBeenCalledTimes(0);
    expect(ha).toHaveBeenCalledTimes(0);

    tauriMock.deliverInbox(
      MAIN,
      "window-message",
      {
        apiVersion: 1,
        type: "content-handoff-ready",
        payload: {
          content: { kind: "pty", id: "i1" },
          transferId: null,
          payload: { sessionId: "s1", windowLabel: TERMINAL },
        },
      },
      { label: TERMINAL, kind: "terminal" },
    );
    expect(hp).toHaveBeenCalledTimes(1);
    expect(hf).toHaveBeenCalledTimes(1);

    // Reverse: one inbox subscription serves all three registrations, and a same-phase message of
    // another kind raises no warning.
    expect(invokesOf("subscribe_window_inbox")).toHaveLength(1);
  });

  it("CH-5 drops generic messages whose claimed window label differs from the stamped source", async () => {
    tauriMock.setCurrentWindowLabel(MAIN);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = vi.fn();
    await onContentHandoff("file", "ready", handler);

    const envelope = {
      apiVersion: 1,
      type: "content-handoff-ready",
      payload: {
        content: { kind: "file", id: "d1" },
        transferId: "t2",
        payload: { windowLabel: CONTENT },
      },
    };
    tauriMock.deliverInbox(MAIN, "window-message", envelope, {
      label: OTHER_CONTENT,
      kind: "workspaceContent",
    });
    expect(handler).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "workspace_content_event.source_mismatch",
      "content-handoff-ready",
    );

    // Reverse: the same envelope from the matching source is delivered once, with no further warning.
    warn.mockClear();
    tauriMock.deliverInbox(MAIN, "window-message", envelope, {
      label: CONTENT,
      kind: "workspaceContent",
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({
      payload: { documentId: "d1", token: "t2", windowLabel: CONTENT },
      source: { label: CONTENT, kind: "workspaceContent" },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("CH-6 drops generic messages that are malformed or whose per-kind payload is invalid", async () => {
    tauriMock.setCurrentWindowLabel(MAIN);
    const hf = vi.fn();
    const hp = vi.fn();
    await onContentHandoff("file", "state-changed", hf);
    await onContentHandoff("pty", "failed", hp);
    const fileSource = { label: CONTENT, kind: "workspaceContent" as const };
    const terminalSource = { label: TERMINAL, kind: "terminal" as const };

    // Malformed wire shapes and invalid per-kind payloads: nothing is delivered and nothing throws.
    const badFile = [
      {
        apiVersion: 1,
        type: "content-handoff-state-changed",
        payload: { transferId: null, payload: {} },
      },
      {
        apiVersion: 1,
        type: "content-handoff-state-changed",
        payload: {
          content: { kind: "markdown", id: "d1" },
          transferId: null,
          payload: {},
        },
      },
      {
        apiVersion: 1,
        type: "content-handoff-state-changed",
        payload: {
          content: { kind: "file", id: "d1" },
          transferId: null,
          payload: {
            fileDocument,
            fileBuffer: { documentId: "d1", text: "x" },
          },
        },
      },
      {
        apiVersion: 1,
        type: "content-handoff-state-changed",
        payload: {
          content: { kind: "file", id: "d1" },
          payload: { fileDocument, fileBuffer },
        },
      },
    ];
    for (const envelope of badFile) {
      tauriMock.deliverInbox(MAIN, "window-message", envelope, fileSource);
    }
    expect(hf).toHaveBeenCalledTimes(0);
    tauriMock.deliverInbox(
      MAIN,
      "window-message",
      {
        apiVersion: 1,
        type: "content-handoff-failed",
        payload: {
          content: { kind: "pty", id: "i1" },
          transferId: null,
          payload: { windowLabel: TERMINAL, message: "x" },
        },
      },
      terminalSource,
    );
    expect(hp).toHaveBeenCalledTimes(0);

    // Reverse: valid messages of the same two registrations are delivered.
    tauriMock.deliverInbox(
      MAIN,
      "window-message",
      {
        apiVersion: 1,
        type: "content-handoff-state-changed",
        payload: {
          content: { kind: "file", id: "d1" },
          transferId: "t3",
          payload: { windowLabel: CONTENT, fileDocument, fileBuffer },
        },
      },
      fileSource,
    );
    tauriMock.deliverInbox(
      MAIN,
      "window-message",
      {
        apiVersion: 1,
        type: "content-handoff-failed",
        payload: {
          content: { kind: "pty", id: "i1" },
          transferId: null,
          payload: { sessionId: "s1", windowLabel: TERMINAL, message: "x" },
        },
      },
      terminalSource,
    );
    expect(hf).toHaveBeenCalledTimes(1);
    expect(hp).toHaveBeenCalledTimes(1);
  });
});

describe("content handoff vocabulary", () => {
  it("CH-7 leaves no per-kind wire types or legacy protocol functions in production source", () => {
    const RETIRED = [
      "pty-detached-ready",
      "pty-detached-failed",
      "pty-detached-exited",
      "pty-return-requested",
      "pty-return-complete",
      "pty-return-failed",
      "pty-return-drop-requested",
      "workspace-file-window-ready",
      "workspace-file-window-init",
      "workspace-file-window-attached",
      "workspace-file-window-attach-failed",
      "workspace-file-window-buffer-changed",
      "workspace-file-window-flush-requested",
      "workspace-file-window-flush-complete",
      "workspace-file-window-return-requested",
      "workspace-file-window-return-complete",
      "workspace-file-window-return-failed",
      "workspace-file-window-return-drop-requested",
      "emitWorkspaceContentWindowEvent",
      "listenWorkspaceContentWindowEvent",
      "WORKSPACE_CONTENT_WINDOW_MESSAGE_TYPES",
      "WorkspaceContentWindowEventPayloads",
      "WorkspaceContentWindowEventName",
    ];
    const ANY_SEND = /(?:sendContentHandoff|ports\.emit)\(/g;
    const CHILD_FILES =
      /(StandalonePtyWindow\.tsx|StandaloneWorkspaceFileWindow\.tsx|useDetachedContentWindow\.ts)$/;
    const sources = import.meta.glob("../**/*.{ts,tsx}", {
      eager: true,
      query: "?raw",
      import: "default",
    }) as Record<string, string>;
    const production = Object.entries(sources).filter(
      ([path]) => !/\.test\.|\/test\//.test(path),
    );

    for (const [path, text] of production) {
      for (const name of RETIRED) {
        expect(text.includes(name), `${path} still contains ${name}`).toBe(
          false,
        );
      }
    }

    // Reverse: the migrated sites are where the design puts them.
    expect(production.length).toBeGreaterThan(50);
    const byEnd = (suffix: string) =>
      production.find(([path]) => path.endsWith(suffix))?.[1] ?? "";
    expect(byEnd("workspace/windows/contentWindowOrchestrator.ts")).toContain(
      "typeof sendContentHandoff",
    );
    expect(byEnd("workspace/windows/protocolHandlers.file.ts")).toContain(
      "ports.emit(",
    );
    expect(byEnd("workspace/windows/protocolHandlers.pty.ts")).toContain(
      "onContentHandoff(",
    );
    expect(byEnd("workspace/windows/protocolHandlers.file.ts")).toContain(
      "onContentHandoff(",
    );
    expect(
      production.some(
        ([path, text]) =>
          CHILD_FILES.test(path) && text.includes("sendContentHandoff("),
      ),
    ).toBe(true);
    const sendCount = production.reduce(
      (total, [, text]) => total + (text.match(ANY_SEND)?.length ?? 0),
      0,
    );
    // The fixed ANY_SEND pattern sees the single-line calls: 17 at m6-091.
    expect(sendCount).toBe(17);
    // Prettier breaks 11 port calls after `ports`; a whitespace-tolerant count still sees all 23 sends
    // (the six file return-failed sends share one reportReturnFailed helper, which holds the one send).
    const tolerant = production.reduce(
      (total, [, text]) =>
        total +
        (text.match(/(?:sendContentHandoff|\bports\s*\.emit)\(/g)?.length ?? 0),
      0,
    );
    expect(tolerant).toBe(23);
    const host = byEnd("components/PtyWorkspace.tsx");
    expect(host).not.toContain("sendContentHandoff(");
    expect(host).not.toContain("onContentHandoff(");
    expect(host).not.toContain("ports.emit(");
  });

  it("CH-9 the encoder and the delivery path agree with the shared PTY return-requested fixture", async () => {
    // The fixture is generated by Rust (fixtures.rs) and read by the Rust relay test as well.
    const shared = import.meta.glob(
      "../../contracts/fixtures/content-handoff-pty-return-requested.json",
      { eager: true, import: "default" },
    ) as Record<
      string,
      { cases: Array<{ name: string; value: Record<string, unknown> }> }
    >;
    const fixture = Object.values(shared);
    expect(fixture).toHaveLength(1);
    const envelope = fixture[0].cases.find(
      (item) => item.name === "ptyReturnRequested",
    )!.value;
    const payload = {
      instanceId: "8e783338-f464-4b10-b15e-b534748c6241",
      sessionId: "session-1",
      windowLabel: TERMINAL,
      token: "return-1",
      handoffToken: "rust-return-1",
    };

    // Encoder: the wire envelope equals the shared sample.
    expect(envelope).toMatchObject({
      apiVersion: 1,
      type: "content-handoff-return-requested",
    });
    expect(envelope.payload).toEqual(encodeContentHandoff("pty", payload));

    // Delivery: the sample, received from the terminal window, reaches the handler with the Rust token.
    tauriMock.setCurrentWindowLabel(MAIN);
    const handler = vi.fn();
    await onContentHandoff("pty", "return-requested", handler);
    tauriMock.deliverInbox(MAIN, "window-message", envelope, {
      label: TERMINAL,
      kind: "terminal",
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].payload).toEqual(payload);
  });

  it("CH-7b leaves no retired wire names in the normative documents either", () => {
    // The same retired names as CH-7; history lives in the milestone files, which are not scanned.
    const RETIRED = [
      "pty-detached-ready",
      "pty-return-requested",
      "pty-return-complete",
      "pty-return-failed",
      "workspace-file-window-",
      "emitWorkspaceContentWindowEvent",
      "listenWorkspaceContentWindowEvent",
      "WORKSPACE_CONTENT_WINDOW_MESSAGE_TYPES",
      "WorkspaceContentWindowEventPayloads",
      "WorkspaceContentWindowEventName",
    ];
    const normative = import.meta.glob(
      [
        "../../docs/architecture.md",
        "../../docs/ui-design.md",
        "../../README.md",
      ],
      { eager: true, query: "?raw", import: "default" },
    ) as Record<string, string>;

    // Reverse: all three documents are actually read.
    expect(Object.keys(normative)).toHaveLength(3);
    for (const [path, text] of Object.entries(normative)) {
      for (const name of RETIRED) {
        expect(text.includes(name), `${path} still mentions ${name}`).toBe(
          false,
        );
      }
    }
  });

  it("CH-8 declares the kind and phase vocabulary literally", () => {
    expect(CONTENT_HANDOFF_PHASES.pty).toEqual([
      "exited",
      "failed",
      "ready",
      "return-complete",
      "return-drop-requested",
      "return-failed",
      "return-requested",
    ]);
    expect(CONTENT_HANDOFF_PHASES.file).toEqual([
      "attached",
      "failed",
      "flush-complete",
      "flush-requested",
      "init",
      "ready",
      "return-complete",
      "return-drop-requested",
      "return-failed",
      "return-requested",
      "state-changed",
    ]);
    expect(CONTENT_HANDOFF_MESSAGE_TYPES).toEqual([
      "content-handoff-attached",
      "content-handoff-exited",
      "content-handoff-failed",
      "content-handoff-flush-complete",
      "content-handoff-flush-requested",
      "content-handoff-init",
      "content-handoff-ready",
      "content-handoff-return-complete",
      "content-handoff-return-drop-requested",
      "content-handoff-return-failed",
      "content-handoff-return-requested",
      "content-handoff-state-changed",
    ]);
    // Reverse: the two kinds have 7 and 11 phases, 18 in total, collapsed to 12 message types.
    expect(CONTENT_HANDOFF_PHASES.pty.length).toBe(7);
    expect(CONTENT_HANDOFF_PHASES.file.length).toBe(11);
    expect(CONTENT_HANDOFF_MESSAGE_TYPES.length).toBe(12);
  });
});

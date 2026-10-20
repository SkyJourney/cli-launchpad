// @vitest-environment jsdom
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "react-i18next",
  async () => (await import("../test/host/hostMocks")).reactI18nextMock,
);
vi.mock(
  "sonner",
  async () => (await import("../test/host/hostMocks")).sonnerMock,
);
vi.mock(
  "./PtyTerminal",
  async () => (await import("../test/host/hostMocks")).ptyTerminalMock,
);

import { tauriMock } from "../test/tauriMock";
import { resetFakeTerminals } from "../test/host/hostMocks";
import {
  detachFileToWindow,
  detachPtyToWindow,
  emitToMain,
  flush,
  launchPty,
  mountWorkspace,
  openFile,
  relayedHandoffs,
  type WorkspaceHost,
} from "../test/host/workspaceHarness";
import { WorkspaceContentCoordinator } from "../lib/workspaceContentCoordinator";

let host: WorkspaceHost | undefined;
afterEach(async () => {
  host?.dispose();
  host = undefined;
  cleanup();
  resetFakeTerminals();
  vi.useRealTimers();
  await flush();
  expect(tauriMock.state.eventListeners).toHaveLength(0);
});

function windowTokenOf(
  coordinator: WorkspaceContentCoordinator,
  ref: { kind: "pty"; slotId: string } | { kind: "file"; documentId: string },
) {
  const state = coordinator.get(ref);
  return state?.phase === "detached" ? state.windowToken : undefined;
}

describe("handoff identity layers in the host", () => {
  it("issues a PTY transfer id and window token that both differ from the Rust handoff token", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    const beginDetach = vi.spyOn(coordinator, "beginDetach");
    host = await mountWorkspace({ coordinator });
    const { slot, terminal } = await launchPty(host);

    const detached = await detachPtyToWindow(host, slot.instanceId);
    await detached.detachPromise;

    const transferId = beginDetach.mock.calls[0][3];
    const rustToken = (await terminal.captureHandoff.mock.results[0].value)
      .token;
    const windowToken = windowTokenOf(coordinator, {
      kind: "pty",
      slotId: slot.instanceId,
    });
    expect(transferId.trim().length).toBeGreaterThan(0);
    expect(transferId).not.toBe(rustToken);
    expect(windowToken?.trim().length).toBeGreaterThan(0);
    expect(windowToken).not.toBe(transferId);
    expect(windowToken).not.toBe(rustToken);
    expect(host.errors).toEqual([]);
  });

  it("issues a file window token that differs from the detach transfer id", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    const beginDetach = vi.spyOn(coordinator, "beginDetach");
    host = await mountWorkspace({ coordinator });
    const doc = await openFile(host);

    const detached = await detachFileToWindow(host, doc.id);
    await detached.detachPromise;

    const transferId = beginDetach.mock.calls[0][3];
    expect(detached.token.trim().length).toBeGreaterThan(0);
    expect(transferId).not.toBe(detached.token);
    expect(
      windowTokenOf(coordinator, { kind: "file", documentId: doc.id }),
    ).toBe(detached.token);
    expect(host.errors).toEqual([]);
  });

  it("returns a file with a fresh transfer id and echoes the window token to the child", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    const doc = await openFile(host);
    const detached = await detachFileToWindow(host, doc.id);
    await detached.detachPromise;
    const beginReturn = vi.spyOn(coordinator, "beginReturn");

    await emitToMain("workspace-file-window-return-requested", {
      documentId: doc.id,
      token: detached.token,
      windowLabel: detached.windowLabel,
      fileDocument: doc,
      fileBuffer: detached.initBuffer,
    });
    await flush(20);

    expect(beginReturn).toHaveBeenCalledTimes(1);
    expect(beginReturn.mock.calls[0][1]).not.toBe(detached.token);
    expect(coordinator.get({ kind: "file", documentId: doc.id })?.phase).toBe(
      "attached",
    );
    const complete = relayedHandoffs().find(
      (message) =>
        message.target === detached.windowLabel &&
        message.legacyType === "workspace-file-window-return-complete",
    );
    expect(complete?.payload).toEqual({
      documentId: doc.id,
      token: detached.token,
    });
    expect(host.errors).toEqual([]);
  });

  it("attaches the PTY with the Rust token carried in handoffToken while token stays the transfer id", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    const { slot, terminal } = await launchPty(host);
    const detached = await detachPtyToWindow(host, slot.instanceId);
    await detached.detachPromise;
    terminal.attachHandoff.mockClear();

    await emitToMain("pty-return-requested", {
      instanceId: slot.instanceId,
      sessionId: slot.sessionId,
      windowLabel: detached.windowLabel,
      token: "transfer-1",
      handoffToken: "rust-1",
    });
    await flush(20);

    expect(terminal.attachHandoff).toHaveBeenCalledWith(
      slot.sessionId,
      "rust-1",
    );
    expect(terminal.attachHandoff).not.toHaveBeenCalledWith(
      slot.sessionId,
      "transfer-1",
    );
    expect(
      coordinator.get({ kind: "pty", slotId: slot.instanceId })?.phase,
    ).toBe("attached");
    expect(host.errors).toEqual([]);
  });

  it("ignores a PTY return request that does not carry the Rust handoff token", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    const { slot, terminal } = await launchPty(host);
    const detached = await detachPtyToWindow(host, slot.instanceId);
    await detached.detachPromise;
    terminal.attachHandoff.mockClear();

    await emitToMain("pty-return-requested", {
      instanceId: slot.instanceId,
      sessionId: slot.sessionId,
      windowLabel: detached.windowLabel,
      token: "transfer-1",
    });
    await flush(20);

    expect(terminal.attachHandoff).not.toHaveBeenCalled();
    expect(
      coordinator.get({ kind: "pty", slotId: slot.instanceId })?.phase,
    ).toBe("detached");
    expect(host.errors).toEqual([]);
  });
});

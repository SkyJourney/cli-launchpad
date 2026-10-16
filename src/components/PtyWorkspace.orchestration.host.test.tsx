// @vitest-environment jsdom
import { act, cleanup } from "@testing-library/react";
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
import { assertWorkspaceInvariants } from "../test/host/workspaceInvariants";
import {
  detachFileToWindow,
  emitToMain,
  flush,
  invokes,
  launchPty,
  mountWorkspace,
  openFile,
  type WorkspaceHost,
} from "../test/host/workspaceHarness";
import { listWorkspacePanes } from "../lib/ptyWorkspaceLayout";
import { WorkspaceContentCoordinator } from "../lib/workspaceContentCoordinator";
import type { AppExitImpacts } from "../lib/appExitImpacts";

let host: WorkspaceHost | undefined;
const lastCreatedWindow = () => {
  const windows = tauriMock.state.createdWindows;
  return windows[windows.length - 1]!;
};
afterEach(async () => {
  host?.dispose();
  host = undefined;
  cleanup();
  resetFakeTerminals();
  vi.useRealTimers();
  await flush();
  expect(tauriMock.state.eventListeners).toHaveLength(0);
  // ACL 拒绝会被宿主吞掉时用例仍可能通过，所以显式断言没有任何权限违规。
  expect(tauriMock.state.aclViolations).toEqual([]);
});

describe("window orchestration", () => {
  it("pty-detached-exited before ready rejects the detach and removes the slot", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    const h = await mountWorkspace({ coordinator });
    host = h;
    const { slot } = await launchPty(h);

    let outcome!: Promise<string>;
    await act(async () => {
      outcome = h
        .ctx()
        .detachSession(slot.instanceId)
        .then(
          () => "resolved",
          (reason: unknown) => (reason as Error).message,
        );
    });
    await flush();
    const windowLabel = lastCreatedWindow().label;

    await emitToMain("pty-detached-exited", {
      instanceId: slot.instanceId,
      sessionId: slot.sessionId,
      windowLabel,
    });
    await flush();

    expect(await outcome).toBe("pty.detachedExitedBeforeReady");
    expect(
      h
        .ctx()
        .slots.some((candidate) => candidate.instanceId === slot.instanceId),
    ).toBe(false);
    expect(tauriMock.state.windowActions).toContainEqual(
      expect.objectContaining({ windowLabel, action: "destroy" }),
    );
    expect(() => assertWorkspaceInvariants(h)).not.toThrow();
    expect(h.ctx().detachedInstanceIds.has(slot.instanceId)).toBe(false);
    expect(h.errors).toEqual([]);
  });

  it("workspace-file-window-attach-failed rejects the detach, destroys the child window and keeps the file in its pane", async () => {
    const h = await mountWorkspace({
      coordinator: new WorkspaceContentCoordinator(),
    });
    host = h;
    const doc = await openFile(h);

    let outcome!: Promise<string>;
    await act(async () => {
      outcome = h
        .ctx()
        .detachFile(doc.id)
        .then(
          () => "resolved",
          (reason: unknown) => (reason as Error).message,
        );
    });
    await flush();
    const created = lastCreatedWindow();
    const token = new URL(
      (created.options as { url: string }).url,
      "http://localhost",
    ).searchParams.get("fileHandoffToken")!;

    await emitToMain("workspace-file-window-attach-failed", {
      documentId: doc.id,
      token,
      windowLabel: created.label,
      message: "boom",
    });
    await flush();

    expect(await outcome).toBe("boom");
    expect(tauriMock.state.windowActions).toContainEqual(
      expect.objectContaining({
        windowLabel: created.label,
        action: "destroy",
      }),
    );
    expect(invokes("revoke_content_window_file").length).toBeGreaterThanOrEqual(
      1,
    );
    expect(
      listWorkspacePanes(h.ctx().tree)
        .flatMap((pane) => pane.contents)
        .some(
          (candidate) =>
            candidate.kind === "file" && candidate.documentId === doc.id,
        ),
    ).toBe(true);
    expect(() => assertWorkspaceInvariants(h)).not.toThrow();
    expect(h.ctx().detachedFileIds.has(doc.id)).toBe(false);
    expect(h.errors).toEqual([]);
  });

  it("collectExitImpacts asks a detached file window to flush and merges the newer buffer", async () => {
    const h = await mountWorkspace({
      coordinator: new WorkspaceContentCoordinator(),
    });
    host = h;
    const doc = await openFile(h);
    const { token, windowLabel, initBuffer } = await detachFileToWindow(
      h,
      doc.id,
    );

    let impacts!: Promise<AppExitImpacts>;
    await act(async () => {
      impacts = h.ctx().collectExitImpacts(0);
    });
    await flush();
    const request = tauriMock.state.emittedEvents.find(
      (event) =>
        event.target === windowLabel &&
        (event.payload as { type?: string }).type ===
          "workspace-file-window-flush-requested",
    );
    const requestId = (request!.payload as { payload: { requestId: string } })
      .payload.requestId;

    await emitToMain("workspace-file-window-flush-complete", {
      requestId,
      documentId: doc.id,
      token,
      windowLabel,
      fileDocument: doc,
      fileBuffer: {
        ...initBuffer,
        content: "edited in child",
        version: initBuffer.version + 1,
      },
    });
    await flush();

    const result = await impacts;
    expect(result.dirtyFiles).toEqual([
      { documentId: doc.id, relativePath: doc.relativePath },
    ]);
    expect(h.ctx().fileBuffers[doc.id].content).toBe("edited in child");
    expect(
      tauriMock.state.emittedEvents.filter(
        (event) =>
          (event.payload as { type?: string }).type ===
          "workspace-file-window-flush-requested",
      ),
    ).toHaveLength(1);
    expect(h.errors).toEqual([]);
  });

  it("registers the window protocol listeners once and keeps them across state changes", async () => {
    const h = await mountWorkspace({
      coordinator: new WorkspaceContentCoordinator(),
    });
    host = h;
    // mock 监听记录的是 target 而不是 ownerLabel，这里只按事件名过滤：
    // 测试环境里只有宿主会注册这些事件。
    // All three notification/protocol listeners are handlers of the main window's inbox (m6-061,
    // m6-062): the relayed protocol messages and the two Rust notifications.
    const INBOX_EVENTS = [
      "window-message",
      "pty-session-owner-lost",
      "workspace-content-window-lost",
    ];
    const registered = () =>
      INBOX_EVENTS.map((event) =>
        tauriMock.inboxRegistrationCount("main", event),
      );
    const active = () =>
      INBOX_EVENTS.map((event) => tauriMock.inboxHandlerCount("main", event));
    const registeredBefore = registered();
    const activeBefore = active();

    await openFile(h);
    await launchPty(h);
    await act(async () => {
      h.ctx().focusPane(listWorkspacePanes(h.ctx().tree)[0].id);
    });
    await flush();

    expect(activeBefore[0]).toBeGreaterThanOrEqual(1);
    expect(activeBefore[1]).toBeGreaterThanOrEqual(1);
    // The same listeners stay registered: none was torn down and registered again.
    expect(registered()).toEqual(registeredBefore);
    expect(active()).toEqual(activeBefore);
    expect(h.errors).toEqual([]);
  });
});

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
import { fakeTerminals, resetFakeTerminals } from "../test/host/hostMocks";
import { assertWorkspaceInvariants } from "../test/host/workspaceInvariants";
import {
  DEFAULT_FILE_WINDOW_LABEL,
  DEFAULT_PTY_WINDOW_LABEL,
  detachFileToWindow,
  detachPtyToWindow,
  flush,
  invokes,
  launchPty,
  mountApp,
  mountFileWindow,
  mountPtyWindow,
  mountWorkspace,
  openFile,
} from "../test/host/workspaceHarness";
import { WorkspaceContentCoordinator } from "../lib/workspaceContentCoordinator";
import { useAppStore } from "../store/appStore";

let host: { dispose: () => void } | undefined;
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

describe("host harness helpers", () => {
  it("openFile opens the default project file as a document", async () => {
    const workspace = await mountWorkspace();
    host = workspace;

    const document = await openFile(workspace);

    expect(document.relativePath).toBe("a.txt");
    const calls = invokes("open_project_file");
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toMatchObject({ relativePath: "a.txt" });
    expect(() => assertWorkspaceInvariants(workspace)).not.toThrow();
    expect(workspace.errors).toEqual([]);
  });

  it("launchPty creates a fake terminal session owned by the injected coordinator", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    const workspace = await mountWorkspace({ coordinator });
    host = workspace;

    const { slot, terminal } = await launchPty(workspace);

    expect(slot.sessionId).toBe("session-1");
    expect(terminal.startSession).toHaveBeenCalledTimes(1);
    expect(fakeTerminals).toHaveLength(1);
    expect(workspace.coordinator).toBe(coordinator);
    // 宿主对 attached 内容是懒注册的（S3G-A03）：新建 PTY 只改布局树，coordinator 在
    // 关闭、移动、拆分、分离时才补建状态。所以这里不断言启动后立刻有状态，而是经分离流程
    // 触发登记，证明注入的 coordinator 确实就是宿主使用的那一个（seam 被绕过时此处为 undefined）。
    const content = { kind: "pty" as const, slotId: slot.instanceId };
    const detached = await detachPtyToWindow(workspace, slot.instanceId);
    await expect(detached.detachPromise).resolves.not.toThrow();
    expect(coordinator.get(content)?.phase).toBe("detached");
    expect(coordinator.listWindowOwned()).toEqual([content]);
    expect(assertWorkspaceInvariants(workspace)).toEqual({ skipped: [] });
    expect(workspace.errors).toEqual([]);
  });

  it("detachFileToWindow completes the file handoff", async () => {
    const workspace = await mountWorkspace();
    host = workspace;
    const document = await openFile(workspace);

    const result = await detachFileToWindow(workspace, document.id);

    await expect(result.detachPromise).resolves.not.toThrow();
    expect(result.windowLabel).toMatch(/^workspace-content-/);
    expect(result.token).toBeTruthy();
    expect(typeof result.initBuffer.version).toBe("number");
    expect(workspace.ctx().detachedFileIds.has(document.id)).toBe(true);
    expect(() => assertWorkspaceInvariants(workspace)).not.toThrow();
    expect(workspace.errors).toEqual([]);
  });

  it("detachPtyToWindow completes the PTY handoff", async () => {
    const workspace = await mountWorkspace();
    host = workspace;
    const { slot } = await launchPty(workspace);

    const result = await detachPtyToWindow(workspace, slot.instanceId);

    await expect(result.detachPromise).resolves.not.toThrow();
    expect(result.windowLabel).toMatch(/^terminal-/);
    expect(workspace.ctx().detachedInstanceIds.has(slot.instanceId)).toBe(true);
    expect(() => assertWorkspaceInvariants(workspace)).not.toThrow();
    expect(workspace.errors).toEqual([]);
  });

  it("mountFileWindow mounts the standalone file window under a canonical label and unmounts cleanly", async () => {
    const win = await mountFileWindow();
    host = win;

    expect(tauriMock.state.currentWindowLabel).toBe(DEFAULT_FILE_WINDOW_LABEL);
    expect(win.errors).toEqual([]);
    expect(tauriMock.state.eventListeners.length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain("host crashed");
  });

  it("mountPtyWindow mounts the standalone terminal window and attaches the handoff", async () => {
    const win = await mountPtyWindow();
    host = win;

    expect(tauriMock.state.currentWindowLabel).toBe(DEFAULT_PTY_WINDOW_LABEL);
    expect(win.errors).toEqual([]);
    expect(fakeTerminals.length).toBeGreaterThanOrEqual(1);
    expect(
      fakeTerminals.some(
        (handle) => handle.attachHandoff.mock.calls.length > 0,
      ),
    ).toBe(true);
    expect(document.body.textContent).not.toContain("host crashed");
  });

  it("mountApp renders the application shell on the projects view", async () => {
    const app = await mountApp();
    host = app;

    expect(app.errors).toEqual([]);
    expect(useAppStore.getState().view).toBe("projects");
    expect(invokes("list_directories").length).toBeGreaterThanOrEqual(1);
    expect(document.body.textContent).not.toContain("host crashed");
  });
});

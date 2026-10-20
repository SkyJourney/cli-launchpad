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
import { resetFakeTerminals, toastSpy } from "../test/host/hostMocks";
import { assertWorkspaceInvariants } from "../test/host/workspaceInvariants";
import {
  detachFileToWindow,
  flush,
  invokes,
  mountWorkspace,
  openFile,
  type WorkspaceHost,
  relayedHandoffs,
} from "../test/host/workspaceHarness";

let host: WorkspaceHost | undefined;
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

describe("PtyWorkspace host harness", () => {
  it("mounts, hydrates a missing layout and persists a valid snapshot without leaking listeners", async () => {
    host = await mountWorkspace();

    expect(host.ctx().hydrationStatus).toBe("ready");
    expect(invokes("get_workspace_layout")).toHaveLength(1);
    expect(host.backend.saved.length).toBeGreaterThanOrEqual(1);
    for (const saved of host.backend.saved) {
      expect(saved.layout.schemaVersion).toBe(5);
    }
    expect(assertWorkspaceInvariants(host)).toEqual({ skipped: ["I4", "I7"] });

    host.dispose();
    await flush();
    expect(tauriMock.state.eventListeners).toHaveLength(0);
    expect(host.errors).toEqual([]);
    expect(toastSpy.error).not.toHaveBeenCalled();
  });

  it("hydrates once and detaches a file correctly under StrictMode", async () => {
    host = await mountWorkspace({ strict: true });
    const doc = await openFile(host);
    const result = await detachFileToWindow(host, doc.id);
    await result.detachPromise;
    await flush();

    expect(host.ctx().hydrationStatus).toBe("ready");
    // StrictMode 可能让 effect 重跑一次，因此只允许 1 或 2 次读取。
    expect(invokes("get_workspace_layout").length).toBeGreaterThanOrEqual(1);
    expect(invokes("get_workspace_layout").length).toBeLessThanOrEqual(2);
    expect(tauriMock.state.createdWindows).toHaveLength(1);
    const inits = relayedHandoffs().filter(
      (event) => event.legacyType === "workspace-file-window-init",
    );
    expect(inits).toHaveLength(1);
    expect(host.ctx().detachedFileIds.has(doc.id)).toBe(true);
    expect(assertWorkspaceInvariants(host)).toEqual({ skipped: ["I4", "I7"] });
    expect(host.errors).toEqual([]);
  });
});

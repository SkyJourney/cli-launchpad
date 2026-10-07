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
  flush,
  invokes,
  mountWorkspace,
  type WorkspaceHost,
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
});

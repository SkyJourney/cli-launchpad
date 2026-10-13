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
import {
  flush,
  launchPty,
  mountWorkspace,
  openFile,
  type WorkspaceHost,
} from "../test/host/workspaceHarness";
import { listWorkspacePanes } from "../lib/ptyWorkspaceLayout";
import { WORKSPACE_COMMAND_KEYS } from "../workspace/host/workspaceContexts";

let host: WorkspaceHost | undefined;

afterEach(async () => {
  host?.dispose();
  host = undefined;
  cleanup();
  resetFakeTerminals();
  vi.useRealTimers();
  await flush();
  expect(tauriMock.state.eventListeners).toHaveLength(0);
  expect(tauriMock.state.aclViolations).toEqual([]);
});

describe("workspace commands context", () => {
  it("keeps the commands object stable while workspace state changes", async () => {
    host = await mountWorkspace();
    const before = host.commands();
    const paneId = listWorkspacePanes(host.ctx().tree)[0].id;
    const focusBefore = host.ctx().focusedPaneId;

    // 拆分会改变树并把焦点移到新 pane，使 focusedPaneId 真正变化。
    await act(async () => {
      host!.ctx().splitPane(paneId, "horizontal");
    });
    await openFile(host);
    await launchPty(host);
    await flush();

    const after = host.commands();
    expect(after).toBe(before);
    const unstable = WORKSPACE_COMMAND_KEYS.filter(
      (key) => !Object.is(after[key], before[key]),
    );
    expect(unstable).toEqual([]);
    expect(WORKSPACE_COMMAND_KEYS).toHaveLength(33);
    // 反向：状态确实变化了（焦点、树与槽位都已改变）。
    expect(host.ctx().focusedPaneId).not.toBe(focusBefore);
    expect(host.ctx().slots).toHaveLength(1);
    expect(host.errors).toEqual([]);
  });
});

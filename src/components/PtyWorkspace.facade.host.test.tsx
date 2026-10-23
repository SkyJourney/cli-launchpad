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
  flush,
  mountWorkspace,
  type WorkspaceHost,
} from "../test/host/workspaceHarness";

// 实测键列表（字典序）。m6-046 步骤 1 从重构前的 usePtyWorkspace() 取得，
// 任何增删键都会使本测试失败（门面冻结）。
const FROZEN_FACADE_KEYS: string[] = [
  "activateFile",
  "activateSession",
  "activateUnsupportedContent",
  "applyWorkspaceLayoutPreset",
  "cancelBackupRestore",
  "closeContents",
  "closeEmptyPane",
  "closingContentKeys",
  "collectExitImpacts",
  "saveFiles",
  "detachedFileIds",
  "detachedInstanceIds",
  "detachFile",
  "detachSession",
  "editFile",
  "fileBuffers",
  "fileDocuments",
  "focusedPaneId",
  "focusPane",
  "getBackupRestoreBlockers",
  "getCurrentPresetLayout",
  "getDirectoryRemovalBlockers",
  "handoffFileIds",
  "hasDetachedSessions",
  "hydrationError",
  "hydrationStatus",
  "isManagedDetachedDrag",
  "isManagedDetachedFileDrag",
  "launchSession",
  "layoutResetError",
  "layoutResetPending",
  "layoutSaveError",
  "loadFile",
  "moveFile",
  "moveSession",
  "openProjectFile",
  "portalTargets",
  "recordSession",
  "rehydrateWorkspace",
  "removeSlot",
  "resetWorkspace",
  "resumeAfterFailedRestore",
  "retryHydration",
  "saveFile",
  "slots",
  "splitAndMoveFile",
  "splitAndMoveSession",
  "splitPane",
  "terminalRefs",
  "tree",
  "updateSplitRatio",
  "workspaceTreeRevision",
];

let host: WorkspaceHost | undefined;
afterEach(async () => {
  host?.dispose();
  host = undefined;
  cleanup();
  resetFakeTerminals();
  await flush();
  expect(tauriMock.state.eventListeners).toHaveLength(0);
});

describe("usePtyWorkspace facade freeze", () => {
  it("exposes exactly the frozen usePtyWorkspace facade keys", async () => {
    host = await mountWorkspace();

    const keys = Object.keys(host.ctx()).sort();
    // 先在空列表上运行，失败信息里的 Received 即为实测键列表。
    expect(keys).toEqual([...FROZEN_FACADE_KEYS].sort());
    expect(FROZEN_FACADE_KEYS.length).toBe(keys.length);
    expect(new Set(FROZEN_FACADE_KEYS).size).toBe(FROZEN_FACADE_KEYS.length);
  });
});

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

import { resetFakeTerminals } from "../test/host/hostMocks";
import {
  createBackend,
  flush,
  mountWorkspace,
  type WorkspaceHost,
} from "../test/host/workspaceHarness";
import { toastSpy } from "../test/host/hostMocks";

// m6-115：活动文件的加载只由显式入口触发（布局水合、执行器提交、关闭批次），不再由渲染期效果触发。
const RESTORED_LAYOUT = {
  status: { status: "ready" as const },
  revision: 1,
  schemaVersion: 5,
  slotStates: [],
  updatedAtMs: null,
  layout: {
    schemaVersion: 5,
    tree: {
      kind: "pane" as const,
      id: "p1",
      paneNumber: 1,
      contents: [{ kind: "file" as const, documentId: "d1" }],
      activeContent: { kind: "file" as const, documentId: "d1" },
    },
    focusedPaneId: "p1",
    slots: [],
    documents: [
      {
        id: "d1",
        directoryId: 1,
        directoryPath: "C:/project",
        relativePath: "a.txt",
      },
    ],
    detachedContents: [],
  },
};

let host: WorkspaceHost | undefined;

afterEach(() => {
  host?.dispose();
  host = undefined;
  resetFakeTerminals();
  toastSpy.error.mockClear();
  cleanup();
});

describe("explicit active file loading (m6-115)", () => {
  it("loads the active file of a restored layout through the explicit layout step", async () => {
    host = await mountWorkspace({
      backend: createBackend({ ...RESTORED_LAYOUT }),
    });
    await flush(10);

    expect(host.ctx().fileBuffers.d1).toBeDefined();
    expect(host.errors).toEqual([]);
    expect(toastSpy.error).not.toHaveBeenCalled();
  });
});

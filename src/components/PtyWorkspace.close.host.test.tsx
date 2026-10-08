// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
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
  openFile,
  type WorkspaceHost,
} from "../test/host/workspaceHarness";
import { listWorkspacePanes } from "../lib/ptyWorkspaceLayout";
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
  // ACL 拒绝会被宿主吞掉时用例仍可能通过，所以显式断言没有任何权限违规。
  expect(tauriMock.state.aclViolations).toEqual([]);
});

describe("render-error placeholder", () => {
  it("closes a known-kind content from its render-error placeholder", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    // 预期内的渲染错误日志：保留调用记录但不打印。
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      // harness 的 throwOnRender 只在渲染时读取，事后开关不会触发重新渲染；
      // 所以先开启，再打开文件，让该文件的编辑器第一次渲染就失败。
      host.editor.setThrowOnRender(true);
      const doc = await openFile(host);
      await flush();

      const alert = screen
        .getAllByRole("alert")
        .find((element) => element.textContent?.includes("engine exploded"));
      expect(alert).toBeDefined();
      fireEvent.click(within(alert!).getByRole("button"));
      await flush();

      expect(host.ctx().fileDocuments).toEqual([]);
      const remaining = listWorkspacePanes(host.ctx().tree).flatMap(
        (pane) => pane.contents,
      );
      expect(remaining).not.toContainEqual({
        kind: "file",
        documentId: doc.id,
      });
      expect(host.editor.releaseDocument).toHaveBeenCalledTimes(1);
      expect(host.editor.releaseDocument).toHaveBeenCalledWith(doc.id);
      // 反向断言：渲染错误被内容级 ErrorBoundary 吸收，没有冒泡到宿主。
      expect(host.errors).toEqual([]);
    } finally {
      consoleError.mockRestore();
    }
  });
});

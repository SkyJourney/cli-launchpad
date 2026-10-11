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
import { act } from "@testing-library/react";
import { createBackend, DIRECTORY } from "../test/host/workspaceHarness";

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

describe("editor model release", () => {
  it("releases models of documents dropped by rehydrateWorkspace", async () => {
    host = await mountWorkspace();
    const doc = await openFile(host);

    await act(async () => {
      await host!.ctx().rehydrateWorkspace();
    });
    await flush();

    expect(host.editor.releaseDocument).toHaveBeenCalledWith(doc.id);
    // 反向断言：同一个 id 不得被释放两次（rehydrate 先释放，hydrate 内差集为空）。
    expect(
      host.editor.releaseDocument.mock.calls.filter(([id]) => id === doc.id),
    ).toHaveLength(1);
    expect(host.ctx().fileDocuments).toEqual([]);
  });

  it("releases models of documents replaced by retry hydration", async () => {
    const backend = createBackend();
    backend.handlers.set("get_workspace_layout", () => {
      throw { code: "x", message: "boom" };
    });
    host = await mountWorkspace({ backend });
    await flush();
    expect(host.ctx().hydrationStatus).toBe("loadFailed");
    const doc = await openFile(host);

    backend.handlers.delete("get_workspace_layout");
    backend.layout = {
      status: { status: "ready" },
      revision: 3,
      schemaVersion: 5,
      updatedAtMs: 1,
      layout: {
        schemaVersion: 5,
        tree: {
          kind: "pane",
          id: "workspace-root",
          paneNumber: 1,
          contents: [],
          activeContent: null,
        },
        focusedPaneId: "workspace-root",
        slots: [],
        documents: [],
        detachedContents: [],
      },
      slotStates: [],
    };
    await act(async () => {
      host!.ctx().retryHydration();
    });
    await flush();

    expect(host.ctx().hydrationStatus).toBe("ready");
    expect(host.ctx().fileDocuments).toEqual([]);
    expect(host.editor.releaseDocument).toHaveBeenCalledWith(doc.id);
    expect(
      host.editor.releaseDocument.mock.calls.filter(([id]) => id === doc.id),
    ).toHaveLength(1);
  });

  it("does not release a document kept across a named layout apply", async () => {
    host = await mountWorkspace();
    const doc = await openFile(host);
    host.backend.handlers.set("plan_apply_workspace_layout_preset", () => ({
      slotStates: [],
      layout: {
        schemaVersion: 5,
        focusedPaneId: "workspace-root",
        slots: [],
        detachedContents: [],
        documents: [
          {
            id: "preset-doc",
            directoryId: DIRECTORY.id,
            directoryPath: DIRECTORY.path,
            relativePath: "a.txt",
          },
        ],
        tree: {
          kind: "pane",
          id: "workspace-root",
          paneNumber: 1,
          contents: [{ kind: "file", documentId: "preset-doc" }],
          activeContent: { kind: "file", documentId: "preset-doc" },
        },
      },
    }));

    await act(async () => {
      await host!.ctx().applyWorkspaceLayoutPreset("preset-1");
    });
    await flush();

    expect(host.editor.releaseDocument).not.toHaveBeenCalled();
    expect(host.ctx().fileDocuments.map((document) => document.id)).toEqual([
      doc.id,
    ]);
  });

  it("a failing release hook does not break rehydration", async () => {
    host = await mountWorkspace();
    await openFile(host);
    host.editor.releaseDocument.mockImplementationOnce(() => {
      throw new Error("release exploded");
    });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      await act(async () => {
        await host!.ctx().rehydrateWorkspace();
      });
      await flush();

      expect(host.ctx().hydrationStatus).toBe("ready");
      expect(
        consoleError.mock.calls.some(
          ([message]) => message === "Workspace file document release failed",
        ),
      ).toBe(true);
      // 反向断言：释放失败没有冒泡成渲染错误。
      expect(host.errors).toEqual([]);
    } finally {
      consoleError.mockRestore();
    }
  });
});

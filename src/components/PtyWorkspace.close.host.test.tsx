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
  invokes,
  mountWorkspace,
  openFile,
  type WorkspaceHost,
} from "../test/host/workspaceHarness";
import { listWorkspacePanes } from "../lib/ptyWorkspaceLayout";
import { WorkspaceContentCoordinator } from "../lib/workspaceContentCoordinator";
import { act } from "@testing-library/react";
import {
  createBackend,
  DIRECTORY,
  launchPty,
} from "../test/host/workspaceHarness";
import { toastSpy } from "../test/host/hostMocks";
import { assertWorkspaceInvariants } from "../test/host/workspaceInvariants";
import { registerBuiltinWorkspaceContentAdapters } from "./workspaceContentAdapters/builtins";
import { getWorkspaceContentAdapter } from "./workspaceContentAdapterRegistry";

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

describe("mixed content close", () => {
  function builtinAdapterCopies() {
    const dispose = registerBuiltinWorkspaceContentAdapters();
    try {
      return {
        pty: { ...getWorkspaceContentAdapter("pty") },
        file: { ...getWorkspaceContentAdapter("file") },
      };
    } finally {
      dispose();
    }
  }

  async function setup(options: { adapters?: unknown } = {}) {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator, ...options } as never);
    const doc = await openFile(host);
    await act(async () => {
      host!.ctx().editFile(doc.id, "dirty");
    });
    const { slot, terminal } = await launchPty(host);
    const refs = [
      { kind: "pty" as const, slotId: slot.instanceId },
      { kind: "file" as const, documentId: doc.id },
    ];
    return { coordinator, doc, slot, terminal, refs };
  }

  it("asks once for running PTY and dirty file impacts and cancels both", async () => {
    const { coordinator, doc, slot, terminal, refs } = await setup();
    await act(async () => {
      void host!.ctx().closeContents(refs, "menu");
    });
    await flush();

    const dialogs = screen.getAllByRole("alertdialog");
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]!.textContent).toContain("pty.confirmCloseMany");
    expect(dialogs[0]!.textContent).toContain("a.txt");
    fireEvent.click(
      within(dialogs[0]!).getByRole("button", { name: "common.cancel" }),
    );
    await flush();

    expect(host!.ctx().fileDocuments.map((d) => d.id)).toEqual([doc.id]);
    expect(host!.ctx().slots.map((s) => s.instanceId)).toEqual([
      slot.instanceId,
    ]);
    expect(terminal.closeSession).not.toHaveBeenCalled();
    expect(host!.ctx().closingContentKeys.size).toBe(0);
    expect(coordinator.get(refs[0]!)?.phase).toBe("attached");
    expect(coordinator.get(refs[1]!)?.phase).toBe("attached");
    // 反向：取消之后不再有确认对话框。
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("closes both after one confirmation and disposes the file once", async () => {
    const { doc, terminal, refs } = await setup();
    await act(async () => {
      void host!.ctx().closeContents(refs, "menu");
    });
    await flush();
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        // m6-108：有未保存文件时，危险动作是“放弃修改并关闭”（语义与旧的“确认”相同）。
        name: "workspaceFiles.discardAndClose",
      }),
    );
    await flush();

    expect(terminal.closeSession).toHaveBeenCalledTimes(1);
    expect(terminal.closeSession).toHaveBeenCalledWith(false);
    expect(host!.ctx().slots).toEqual([]);
    expect(host!.ctx().fileDocuments).toEqual([]);
    expect(host!.editor.releaseDocument).toHaveBeenCalledTimes(1);
    expect(host!.editor.releaseDocument).toHaveBeenCalledWith(doc.id);
    assertWorkspaceInvariants(host!);
    expect(host!.errors).toEqual([]);
  });

  // m6-108：保存全部后关闭。
  it("saves the dirty file and then closes the contents", async () => {
    const { terminal, refs } = await setup();
    host!.backend.handlers.set("save_project_text_file", () => ({
      kind: "saved",
      content: "dirty",
      revision: "r2",
      warning: null,
    }));
    await act(async () => {
      void host!.ctx().closeContents(refs, "menu");
    });
    await flush();

    await act(async () => {
      fireEvent.click(
        within(screen.getByRole("alertdialog")).getByRole("button", {
          name: "workspaceFiles.saveAllAndClose",
        }),
      );
    });
    await flush(10);

    expect(invokes("save_project_text_file")).toHaveLength(1);
    expect(terminal.closeSession).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(host!.errors).toEqual([]);
  });
  it("vetoes the whole batch when one adapter's beforeClose returns false", async () => {
    const copies = builtinAdapterCopies();
    const { doc, terminal, refs } = await setup({
      adapters: [
        copies.pty,
        {
          ...copies.file,
          id: "test.file",
          lifecycle: { ...copies.file.lifecycle, beforeClose: () => false },
        },
      ],
    });
    await act(async () => {
      await host!.ctx().closeContents(refs, "menu");
    });
    await flush();

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(host!.ctx().fileDocuments.map((d) => d.id)).toEqual([doc.id]);
    expect(host!.ctx().slots).toHaveLength(1);
    expect(terminal.closeSession).not.toHaveBeenCalled();
    // 反向：没有内容处于关闭中状态。
    expect(host!.ctx().closingContentKeys.size).toBe(0);
  });

  it("treats a throwing beforeClose as a veto", async () => {
    const copies = builtinAdapterCopies();
    const { doc, terminal, refs } = await setup({
      adapters: [
        copies.pty,
        {
          ...copies.file,
          id: "test.file",
          lifecycle: {
            ...copies.file.lifecycle,
            beforeClose: () => {
              throw new Error("x");
            },
          },
        },
      ],
    });
    await act(async () => {
      await host!.ctx().closeContents(refs, "menu");
    });
    await flush();

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(host!.ctx().fileDocuments.map((d) => d.id)).toEqual([doc.id]);
    expect(host!.ctx().slots).toHaveLength(1);
    expect(terminal.closeSession).not.toHaveBeenCalled();
    expect(host!.errors).toEqual([]);
  });

  it("keeps a PTY whose termination fails and reports it", async () => {
    const { coordinator, terminal, refs } = await setup();
    terminal.closeSession.mockRejectedValueOnce(new Error("kill failed"));
    await act(async () => {
      void host!.ctx().closeContents([refs[0]!], "tab");
    });
    await flush();
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "common.confirm",
      }),
    );
    await flush();

    expect(host!.ctx().slots).toHaveLength(1);
    expect(
      toastSpy.error.mock.calls.some((call) =>
        String(call[0]).includes("pty.closeFailedMany"),
      ),
    ).toBe(true);
    expect(host!.ctx().closingContentKeys.size).toBe(0);
    expect(coordinator.get(refs[0]!)?.phase).toBe("attached");
    expect(host!.errors).toEqual([]);
  });

  it("keeps a terminating PTY in closing and rejects moves until it ends", async () => {
    const { slot, terminal, refs } = await setup();
    terminal.closeSession.mockResolvedValueOnce("terminating");
    await act(async () => {
      host!
        .ctx()
        .splitPane(listWorkspacePanes(host!.ctx().tree)[0]!.id, "horizontal");
    });
    await flush();
    const [paneA, paneB] = listWorkspacePanes(host!.ctx().tree);
    await act(async () => {
      void host!.ctx().closeContents([refs[0]!], "tab");
    });
    await flush();
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "common.confirm",
      }),
    );
    await flush();
    await act(async () => {
      host!.ctx().moveContent(paneA!.id, paneB!.id, { kind: "pty", slotId: slot.instanceId });
    });
    await flush();

    expect(host!.ctx().closingContentKeys.has(`pty:${slot.instanceId}`)).toBe(
      true,
    );
    const stillInA = listWorkspacePanes(host!.ctx().tree).find(
      (p) => p.id === paneA!.id,
    )!;
    expect(
      stillInA.contents.some(
        (c) => c.kind === "pty" && c.slotId === slot.instanceId,
      ),
    ).toBe(true);
    // 反向：移动被拒绝，PTY 没有进入 paneB。
    const inB = listWorkspacePanes(host!.ctx().tree).find(
      (p) => p.id === paneB!.id,
    )!;
    expect(inB.contents.some((c) => c.kind === "pty")).toBe(false);

    const session = host!.store().getSnapshot().ptySessionsById[
      slot.sessionId!
    ]!;
    await act(async () => {
      terminal.emitSessionChange({ ...session, state: "exited" });
    });
    await flush();
    expect(host!.ctx().slots).toEqual([]);
  });
});

describe("close dialog impact lists", () => {
  it("lists running terminals and dirty files in two shared list elements", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator } as never);
    const doc = await openFile(host);
    await act(async () => {
      host!.ctx().editFile(doc.id, "dirty");
    });
    const { slot } = await launchPty(host);
    const refs = [
      { kind: "pty" as const, slotId: slot.instanceId },
      { kind: "file" as const, documentId: doc.id },
    ];
    await act(async () => {
      void host!.ctx().closeContents(refs, "menu");
    });
    await flush();

    const dialog = screen.getByRole("alertdialog");
    const lists = dialog.querySelectorAll("ul.app-exit-unsaved-files");
    expect(lists).toHaveLength(2);
    expect(lists[0]!.querySelectorAll("li")).toHaveLength(1);
    expect(
      [...lists[1]!.querySelectorAll("li")].map((item) => item.textContent),
    ).toEqual(["a.txt"]);
    expect(dialog.textContent).toContain("pty.confirmCloseMany");
    expect(dialog.textContent).toContain("workspaceFiles.discardChanges");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "common.cancel" }),
    );
    await flush();
    // 反向：取消之后内容都还在。
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(host!.ctx().fileDocuments).toHaveLength(1);
    expect(host!.ctx().slots).toHaveLength(1);
  });
});

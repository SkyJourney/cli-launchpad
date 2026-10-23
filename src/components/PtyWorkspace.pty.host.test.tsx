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

import { WorkspaceContentCoordinator } from "../lib/workspaceContentCoordinator";
import { listWorkspacePanes } from "../lib/ptyWorkspaceLayout";
import { validateWorkspaceLayoutDocument } from "../lib/workspaceLayoutPersistence";
import { tauriMock } from "../test/tauriMock";
import {
  fakeTerminals,
  resetFakeTerminals,
  toastSpy,
} from "../test/host/hostMocks";
import { assertWorkspaceInvariants } from "../test/host/workspaceInvariants";
import {
  flush,
  launchPty,
  mountWorkspace,
  openFile,
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
  expect(tauriMock.state.aclViolations).toEqual([]);
});

describe("PTY portal ownership", () => {
  it("keeps one terminal instance across move, split and tab switches", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    const { slot } = await launchPty(host);
    const doc = await openFile(host);

    const paneA = listWorkspacePanes(host.ctx().tree)[0]!;
    await act(async () => {
      host!.ctx().splitPane(paneA.id, "horizontal");
    });
    await flush();
    const paneB = listWorkspacePanes(host.ctx().tree).find(
      (pane) => pane.id !== paneA.id,
    )!;
    await act(async () => {
      host!.ctx().moveSession(paneA.id, paneB.id, slot.instanceId);
    });
    await flush();
    const filePane = listWorkspacePanes(host.ctx().tree).find((pane) =>
      pane.contents.some((content) => content.kind === "file"),
    )!;
    await act(async () => {
      host!.ctx().activateFile(filePane.id, doc.id);
    });
    await act(async () => {
      host!.ctx().activateSession(paneB.id, slot.instanceId);
    });
    await flush();

    expect(fakeTerminals).toHaveLength(1);
    expect(fakeTerminals[0]!.startSession).toHaveBeenCalledTimes(1);
    assertWorkspaceInvariants(host);
    expect(
      document.querySelectorAll("[data-testid=fake-pty-terminal]").length,
    ).toBeLessThanOrEqual(1);
  });

  it("removes a naturally exited PTY and keeps the layout valid", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    const { slot, terminal } = await launchPty(host);
    const sessionId = host
      .ctx()
      .slots.find((item) => item.instanceId === slot.instanceId)!.sessionId!;

    // 步骤 4 之后这一行改为 host.store().getSnapshot().ptySessionsById[sessionId]。
    const session = host!.store().getSnapshot().ptySessionsById[sessionId]!;
    const commitsBefore = host.store().commitCount;
    await act(async () => {
      terminal.emitSessionChange({ ...session, state: "exited" });
    });
    await flush();
    // 槽位移除与树关闭只提交一次。
    expect(host.store().commitCount - commitsBefore).toBe(1);

    expect(host.ctx().slots).toEqual([]);
    expect(
      listWorkspacePanes(host.ctx().tree).some((pane) =>
        pane.contents.some((content) => content.kind === "pty"),
      ),
    ).toBe(false);
    expect(
      host!.store().getSnapshot().ptySessionsById[sessionId],
    ).toBeUndefined();
    const saved = host.backend.saved;
    const lastLayout = saved[saved.length - 1]!.layout;
    expect(() => validateWorkspaceLayoutDocument(lastLayout)).not.toThrow();
    assertWorkspaceInvariants(host);
    expect(host.errors).toEqual([]);
  });
});

describe("rehydrate runtime reset", () => {
  it("rehydrate settles a pending file detach and leaves no dangling promise", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    const doc = await openFile(host);

    const windowsBefore = tauriMock.state.createdWindows.length;
    let settled = false;
    await act(async () => {
      host!
        .ctx()
        .detachFile(doc.id)
        .then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
    });
    await flush();
    expect(tauriMock.state.createdWindows.length - windowsBefore).toBe(1);
    expect(settled).toBe(false);

    await act(async () => {
      await host!.ctx().rehydrateWorkspace();
    });
    await flush(10);

    expect(settled).toBe(true);
    expect(host.ctx().fileDocuments).toEqual([]);
    expect(host.errors).toEqual([]);
    // 反向：允许 detach 的一次失败提示，不允许重复提示。
    expect(toastSpy.error.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("rehydrate settles a pending PTY detach and leaves no dangling promise", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    const { slot } = await launchPty(host);

    const windowsBefore = tauriMock.state.createdWindows.length;
    let settled = false;
    await act(async () => {
      host!
        .ctx()
        .detachSession(slot.instanceId)
        .then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
    });
    await flush();
    expect(tauriMock.state.createdWindows.length - windowsBefore).toBe(1);
    expect(settled).toBe(false);

    await act(async () => {
      await host!.ctx().rehydrateWorkspace();
    });
    await flush(10);

    expect(settled).toBe(true);
    expect(host.ctx().slots).toEqual([]);
    expect(host.errors).toEqual([]);
  });
});

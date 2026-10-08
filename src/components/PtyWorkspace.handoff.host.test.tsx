// @vitest-environment jsdom
import { act, cleanup, screen } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

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
import { assertWorkspaceInvariants } from "../test/host/workspaceInvariants";
import {
  deferred,
  detachFileToWindow,
  detachPtyToWindow,
  emitToMain,
  flush,
  invokes,
  launchPty,
  mountWorkspace,
  openFile,
  type WorkspaceHost,
} from "../test/host/workspaceHarness";
import { listWorkspacePanes } from "../lib/ptyWorkspaceLayout";
import { WorkspaceContentCoordinator } from "../lib/workspaceContentCoordinator";
import type { WorkspaceLayoutDocument } from "../lib/tauri";

let host: WorkspaceHost | undefined;
let consoleError: MockInstance<typeof console.error>;
beforeEach(() => {
  consoleError = vi.spyOn(console, "error");
});
afterEach(async () => {
  host?.dispose();
  host = undefined;
  cleanup();
  resetFakeTerminals();
  vi.useRealTimers();
  await flush();
  // 快照构造异常被宿主 catch 后不会让用例失败，所以显式断言它从未发生；
  // 取数放在卸载之后，卸载时的最后一次持久化也要覆盖到。
  const invalidSnapshots = consoleError.mock.calls.filter(
    ([message]) => message === "[workspace.layout_snapshot_invalid]",
  );
  consoleError.mockRestore();
  expect(tauriMock.state.eventListeners).toHaveLength(0);
  // ACL 拒绝会被宿主吞掉时用例仍可能通过，所以显式断言没有任何权限违规。
  expect(tauriMock.state.aclViolations).toEqual([]);
  expect(invalidSnapshots).toEqual([]);
});

function emittedTypesTo(label: string) {
  return tauriMock.state.emittedEvents
    .filter((event) => event.target === label)
    .map((event) => (event.payload as { type?: string }).type);
}

describe("PTY return to the workspace", () => {
  it("keeps the workspace mounted and persists a valid layout while a PTY is returning", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    const { slot, terminal } = await launchPty(host);
    const { windowLabel } = await detachPtyToWindow(host, slot.instanceId);
    const content = { kind: "pty", slotId: slot.instanceId } as const;
    const attach = deferred<{ sessionId: string; state: string }>();
    terminal.attachHandoff.mockImplementationOnce(() => attach.promise);
    expect(() => assertWorkspaceInvariants(host!)).not.toThrow();

    // 步骤 1：窗口请求返回，attach 保持挂起 → 内容停在 returning。
    await emitToMain("pty-return-requested", {
      instanceId: slot.instanceId,
      sessionId: slot.sessionId,
      windowLabel,
      token: "return-1",
    });
    await flush();
    expect(coordinator.get(content)?.phase).toBe("returning");
    expect(() => assertWorkspaceInvariants(host!)).not.toThrow();

    // 步骤 2：returning 期间触发一次持久化（拆分 pane）。
    const paneId = listWorkspacePanes(host.ctx().tree)[0].id;
    await act(async () => {
      host!.ctx().focusPane(paneId);
      host!.ctx().splitPane(paneId, "horizontal");
    });
    await flush();
    expect(coordinator.get(content)?.phase).toBe("returning");
    const saved = host.backend.saved[host.backend.saved.length - 1];
    // 最后一次保存必须反映 returning 期间发生的拆分，而不是更早的旧快照。
    expect(listWorkspacePanes(saved.layout.tree)).toHaveLength(2);
    expect(host.ctx().layoutSaveError).toBeNull();
    expect(saved.layout.detachedContents).toContainEqual(content);
    expect(saved.layout.slots.map((item) => item.instanceId)).toContain(
      slot.instanceId,
    );
    expect(() => assertWorkspaceInvariants(host!)).not.toThrow();

    // 步骤 3：attach 完成 → 槽位回到树里，窗口被销毁。
    attach.resolve({ sessionId: slot.sessionId!, state: "running" });
    await flush();
    const panesWithSlot = listWorkspacePanes(host.ctx().tree).filter((pane) =>
      pane.contents.some(
        (item) => item.kind === "pty" && item.slotId === slot.instanceId,
      ),
    );
    expect(panesWithSlot).toHaveLength(1);
    expect(host.ctx().detachedInstanceIds.has(slot.instanceId)).toBe(false);
    expect(tauriMock.state.windowActions).toContainEqual(
      expect.objectContaining({ windowLabel, action: "destroy" }),
    );
    expect(() => assertWorkspaceInvariants(host!)).not.toThrow();

    // 步骤 4：卸载（会再持久化一次）。
    host.dispose();
    expect(host.errors).toEqual([]);
    expect(screen.queryByText("host crashed")).toBeNull();
    expect(emittedTypesTo(windowLabel)).not.toContain("pty-return-failed");
  });
});

describe("file return to the workspace", () => {
  async function detachedFileWithTwoPanes(
    coordinator: WorkspaceContentCoordinator,
  ) {
    host = await mountWorkspace({ coordinator });
    const doc = await openFile(host, "a.txt");
    const paneA = listWorkspacePanes(host.ctx().tree)[0].id;
    await act(async () => {
      host!.ctx().splitPane(paneA, "horizontal");
    });
    await flush();
    const paneB = listWorkspacePanes(host.ctx().tree).find(
      (pane) => pane.id !== paneA,
    )!.id;
    const detached = await detachFileToWindow(host, doc.id);
    const returnPayload = {
      documentId: doc.id,
      token: detached.token,
      windowLabel: detached.windowLabel,
      targetPaneId: paneB,
      fileDocument: doc,
      fileBuffer: {
        ...detached.initBuffer,
        content: "edited in window",
        version: detached.initBuffer.version + 1,
      },
    };
    return { doc, paneA, paneB, detached, returnPayload };
  }

  it("returns a detached file to a non-source pane exactly once", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    const { doc, paneA, paneB, detached, returnPayload } =
      await detachedFileWithTwoPanes(coordinator);

    await emitToMain("workspace-file-window-return-requested", returnPayload);
    await flush();

    const panes = listWorkspacePanes(host!.ctx().tree);
    expect(panes.find((pane) => pane.id === paneB)?.contents).toEqual([
      { kind: "file", documentId: doc.id },
    ]);
    expect(
      panes
        .find((pane) => pane.id === paneA)
        ?.contents.some(
          (item) => item.kind === "file" && item.documentId === doc.id,
        ),
    ).toBe(false);
    expect(host!.ctx().detachedFileIds.has(doc.id)).toBe(false);
    expect(emittedTypesTo(detached.windowLabel)).toContain(
      "workspace-file-window-return-complete",
    );
    const revokes = invokes("revoke_content_window_file");
    expect(revokes).toHaveLength(1);
    expect((revokes[0].args as { targetLabel?: string }).targetLabel).toBe(
      detached.windowLabel,
    );
    expect(() => assertWorkspaceInvariants(host!)).not.toThrow();
    expect(host!.errors).toEqual([]);
    expect(emittedTypesTo(detached.windowLabel)).not.toContain(
      "workspace-file-window-return-failed",
    );
    const saved = host!.backend.saved[host!.backend.saved.length - 1];
    expect(saved.layout.detachedContents).not.toContainEqual({
      kind: "file",
      documentId: doc.id,
    });
  });

  it("keeps the returned buffer newer than the stale main mirror", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    const { doc, detached, returnPayload } =
      await detachedFileWithTwoPanes(coordinator);

    await emitToMain("workspace-file-window-return-requested", returnPayload);
    await flush();

    const buffer = host!.ctx().fileBuffers[doc.id];
    expect(buffer.content).toBe("edited in window");
    expect(buffer.version).toBe(detached.initBuffer.version + 1);
    expect(host!.errors).toEqual([]);
  });
});

describe("named layouts while a PTY is returning", () => {
  it("applies a named layout and captures a preset while a PTY is returning", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    const { slot, terminal } = await launchPty(host);
    const { windowLabel } = await detachPtyToWindow(host, slot.instanceId);
    const attach = deferred<{ sessionId: string; state: string }>();
    terminal.attachHandoff.mockImplementationOnce(() => attach.promise);
    // 与 Rust 的 plan 一致：预设只替换树，窗口占有的槽位与 detachedContents 原样带回。
    host.backend.handlers.set(
      "plan_apply_workspace_layout_preset",
      (args: { activeLayout: WorkspaceLayoutDocument }) => ({
        slotStates: args.activeLayout.slots.map((item) => ({
          instanceId: item.instanceId,
          state: "running",
          currentProjectName: item.projectName,
        })),
        layout: {
          ...args.activeLayout,
          focusedPaneId: "p-empty",
          tree: {
            kind: "pane",
            id: "p-empty",
            paneNumber: 1,
            contents: [],
            activeContent: null,
          },
        },
      }),
    );
    host.backend.handlers.set("create_workspace_layout_preset", () => ({
      id: "n",
      name: "n",
      schemaVersion: 5,
      createdAtMs: 0,
      updatedAtMs: 0,
    }));
    await emitToMain("pty-return-requested", {
      instanceId: slot.instanceId,
      sessionId: slot.sessionId,
      windowLabel,
      token: "return-1",
    });
    await flush();
    expect(
      coordinator.get({ kind: "pty", slotId: slot.instanceId })?.phase,
    ).toBe("returning");

    const applied = host.ctx().applyWorkspaceLayoutPreset("p");
    await act(async () => {
      await applied;
    });
    await expect(applied).resolves.toBeUndefined();
    const preset = host.ctx().getCurrentPresetLayout();

    expect(preset.slots.map((item) => item.instanceId)).not.toContain(
      slot.instanceId,
    );
    expect(host.errors).toEqual([]);
    // 预设只替换树；窗口占有的槽位不能因此被当作已结束而丢弃。
    expect(host.ctx().slots.map((item) => item.instanceId)).toContain(
      slot.instanceId,
    );
    expect(() => assertWorkspaceInvariants(host!)).not.toThrow();
    const planCalls = invokes("plan_apply_workspace_layout_preset");
    expect(planCalls.length).toBeGreaterThanOrEqual(1);
    const activeLayout = (
      planCalls[0].args as {
        activeLayout: { detachedContents: unknown[] };
      }
    ).activeLayout;
    expect(activeLayout.detachedContents).toContainEqual({
      kind: "pty",
      slotId: slot.instanceId,
    });
  });
});

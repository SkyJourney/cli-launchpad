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
import type {
  WorkspaceLayoutDocument,
  WorkspacePaneContentRef,
} from "../lib/tauri";
import { workspaceContentKey } from "../lib/workspaceContentKey";

// 在 spy 安装之前取得真实实现，供“只吞掉预期日志、其余照常输出”的用例转发。
const realConsoleError = console.error.bind(console);

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

/** 树中包含该内容的 pane 个数。 */
function panesContaining(
  target: WorkspaceHost,
  content: WorkspacePaneContentRef,
) {
  return listWorkspacePanes(target.ctx().tree).filter((pane) =>
    pane.contents.some(
      (item) => workspaceContentKey(item) === workspaceContentKey(content),
    ),
  ).length;
}

/** 让 coordinator 拒绝 returnReady（归属变更不成立）；其他类型转发给真实实现。 */
function rejectReturnReady(
  coordinator: WorkspaceContentCoordinator,
  options: { once?: boolean } = {},
) {
  const original = coordinator.completeHandoff.bind(coordinator);
  const intercept = (
    content: WorkspacePaneContentRef,
    type: "detachReady" | "returnReady",
    transferId: string,
  ) =>
    type === "returnReady"
      ? ({
          outcome: "ignored",
          state: coordinator.get(content)!,
        } as ReturnType<WorkspaceContentCoordinator["completeHandoff"]>)
      : original(content, type, transferId);
  const spy = vi.spyOn(coordinator, "completeHandoff");
  if (options.once) spy.mockImplementationOnce(intercept);
  else spy.mockImplementation(intercept);
  return spy;
}

/** 与 Rust 的 plan 一致：预设只替换树，窗口占有的槽位、文档与 detachedContents 原样带回。 */
function stubPresetPlan(target: WorkspaceHost) {
  target.backend.handlers.set(
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

  it("does not commit the returned PTY into the tree when the ownership commit is rejected", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    const { slot, terminal } = await launchPty(host);
    const { windowLabel } = await detachPtyToWindow(host, slot.instanceId);
    const content = { kind: "pty", slotId: slot.instanceId } as const;
    const rejected = rejectReturnReady(coordinator);

    await emitToMain("pty-return-requested", {
      instanceId: slot.instanceId,
      sessionId: slot.sessionId,
      windowLabel,
      token: "return-1",
    });
    await flush(10);

    // 失败必须来自被拦截的 returnReady，而不是更早的分支。
    expect(rejected).toHaveBeenCalledWith(content, "returnReady", "return-1");
    expect(panesContaining(host, content)).toBe(0);
    expect(emittedTypesTo(windowLabel)).toContain("pty-return-failed");
    expect(terminal.cancelHandoff).toHaveBeenCalledTimes(1);
    expect(terminal.cancelHandoff).toHaveBeenCalledWith("return-1");
    expect(host.ctx().detachedInstanceIds.has(slot.instanceId)).toBe(true);
    expect(coordinator.get(content)?.phase).toBe("detached");
    expect(() => assertWorkspaceInvariants(host!)).not.toThrow();
    // 反向断言：窗口还在、没有宣告返回完成。
    expect(tauriMock.state.windowActions).not.toContainEqual(
      expect.objectContaining({ windowLabel, action: "destroy" }),
    );
    expect(emittedTypesTo(windowLabel)).not.toContain("pty-return-complete");
    expect(host.errors).toEqual([]);
  });

  it("keeps pane topology edits made while the PTY attach is pending", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    const { slot, terminal } = await launchPty(host);
    const { windowLabel } = await detachPtyToWindow(host, slot.instanceId);
    const content = { kind: "pty", slotId: slot.instanceId } as const;
    const attach = deferred<{ sessionId: string; state: string }>();
    terminal.attachHandoff.mockImplementationOnce(() => attach.promise);

    // 1. 请求返回，attach 保持挂起。
    await emitToMain("pty-return-requested", {
      instanceId: slot.instanceId,
      sessionId: slot.sessionId,
      windowLabel,
      token: "return-1",
    });
    await flush();
    expect(coordinator.get(content)?.phase).toBe("returning");

    // 2. attach 挂起期间用户拆分了 pane。
    const paneA = listWorkspacePanes(host.ctx().tree)[0].id;
    await act(async () => {
      host!.ctx().focusPane(paneA);
      host!.ctx().splitPane(paneA, "horizontal");
    });
    await flush();
    const panesBefore = listWorkspacePanes(host.ctx().tree).map(
      (pane) => pane.id,
    );
    expect(panesBefore).toHaveLength(2);

    // 3. attach 完成：返回必须基于最新的树提交，拆分不能被旧快照覆盖。
    attach.resolve({ sessionId: slot.sessionId!, state: "running" });
    await flush();

    expect(listWorkspacePanes(host.ctx().tree).map((pane) => pane.id)).toEqual(
      panesBefore,
    );
    expect(panesContaining(host, content)).toBe(1);
    expect(host.ctx().detachedInstanceIds.has(slot.instanceId)).toBe(false);
    expect(coordinator.get(content)?.phase).toBe("attached");
    expect(() => assertWorkspaceInvariants(host!)).not.toThrow();
    // 反向断言：没有向窗口发出返回失败，也没有记录错误。
    expect(emittedTypesTo(windowLabel)).not.toContain("pty-return-failed");
    expect(host.errors).toEqual([]);
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

  it("does not commit the returned file into the tree when the ownership commit is rejected", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    const { doc, detached, returnPayload } =
      await detachedFileWithTwoPanes(coordinator);
    const content = { kind: "file", documentId: doc.id } as const;
    const rejected = rejectReturnReady(coordinator);

    await emitToMain("workspace-file-window-return-requested", returnPayload);
    await flush();

    // 失败必须来自被拦截的 returnReady，而不是更早的分支。
    expect(rejected).toHaveBeenCalledWith(
      content,
      "returnReady",
      detached.token,
    );
    expect(panesContaining(host!, content)).toBe(0);
    expect(emittedTypesTo(detached.windowLabel)).toContain(
      "workspace-file-window-return-failed",
    );
    expect(host!.ctx().detachedFileIds.has(doc.id)).toBe(true);
    expect(coordinator.get(content)?.phase).toBe("detached");
    expect(() => assertWorkspaceInvariants(host!)).not.toThrow();
    // 反向断言：没有宣告完成、没有撤销授权、没有销毁窗口。
    expect(emittedTypesTo(detached.windowLabel)).not.toContain(
      "workspace-file-window-return-complete",
    );
    expect(invokes("revoke_content_window_file")).toHaveLength(0);
    expect(tauriMock.state.windowActions).not.toContainEqual(
      expect.objectContaining({
        windowLabel: detached.windowLabel,
        action: "destroy",
      }),
    );
    expect(host!.errors).toEqual([]);
  });

  it("allows the file return to be retried after a rejected ownership commit", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    const { doc, paneA, paneB, detached, returnPayload } =
      await detachedFileWithTwoPanes(coordinator);
    const content = { kind: "file", documentId: doc.id } as const;
    const rejected = rejectReturnReady(coordinator, { once: true });

    await emitToMain("workspace-file-window-return-requested", returnPayload);
    await flush();
    expect(rejected).toHaveBeenCalledWith(
      content,
      "returnReady",
      detached.token,
    );
    expect(panesContaining(host!, content)).toBe(0);
    expect(emittedTypesTo(detached.windowLabel)).toContain(
      "workspace-file-window-return-failed",
    );
    expect(host!.ctx().detachedFileIds.has(doc.id)).toBe(true);

    // 同一份载荷（同一个 token）再发一次：这次走真实实现。
    await emitToMain("workspace-file-window-return-requested", returnPayload);
    await flush();

    const panes = listWorkspacePanes(host!.ctx().tree);
    expect(panes.find((pane) => pane.id === paneB)?.contents).toEqual([
      content,
    ]);
    expect(
      panes
        .find((pane) => pane.id === paneA)
        ?.contents.some(
          (item) => item.kind === "file" && item.documentId === doc.id,
        ),
    ).toBe(false);
    expect(host!.ctx().detachedFileIds.has(doc.id)).toBe(false);
    const types = emittedTypesTo(detached.windowLabel);
    expect(
      types.filter((type) => type === "workspace-file-window-return-complete"),
    ).toHaveLength(1);
    // 反向断言：return-failed 只在第一次被拒绝时发出。
    expect(
      types.filter((type) => type === "workspace-file-window-return-failed"),
    ).toHaveLength(1);
    const revokes = invokes("revoke_content_window_file");
    expect(revokes).toHaveLength(1);
    expect((revokes[0].args as { targetLabel?: string }).targetLabel).toBe(
      detached.windowLabel,
    );
    expect(() => assertWorkspaceInvariants(host!)).not.toThrow();
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
    stubPresetPlan(host);
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

describe("named layouts while a file is detached to a window", () => {
  it("keeps the detached file and its buffer when a named layout is applied", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    const doc = await openFile(host, "a.txt");
    const content = { kind: "file", documentId: doc.id } as const;
    await detachFileToWindow(host, doc.id);
    stubPresetPlan(host);
    const bufferBefore = host.ctx().fileBuffers[doc.id];
    expect(bufferBefore).toBeDefined();

    const applied = host.ctx().applyWorkspaceLayoutPreset("p");
    await act(async () => {
      await applied;
    });
    await flush();

    await expect(applied).resolves.toBeUndefined();
    // 预设只替换树；窗口占有的文件仍属于窗口，缓冲与文档都不能丢。
    expect(panesContaining(host, content)).toBe(0);
    expect(host.ctx().detachedFileIds.has(doc.id)).toBe(true);
    expect(host.ctx().fileDocuments.map((item) => item.id)).toContain(doc.id);
    expect(host.ctx().fileBuffers[doc.id]).toEqual(bufferBefore);
    expect(coordinator.get(content)?.phase).toBe("detached");
    expect(() => assertWorkspaceInvariants(host!)).not.toThrow();
    expect(host.errors).toEqual([]);
    const planCalls = invokes("plan_apply_workspace_layout_preset");
    const activeLayout = (
      planCalls[0].args as { activeLayout: WorkspaceLayoutDocument }
    ).activeLayout;
    expect(activeLayout.detachedContents).toContainEqual(content);
  });
});

describe("layout snapshot failures", () => {
  it("keeps the workspace mounted and recovers when a snapshot cannot be built", async () => {
    // 预期内的诊断日志：保留调用记录但不打印；其他 console.error 照常输出。
    consoleError.mockImplementation((...args: unknown[]) => {
      if (args[0] === "[workspace.layout_snapshot_invalid]") return;
      realConsoleError(...args);
    });
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    const { slot } = await launchPty(host);
    await detachPtyToWindow(host, slot.instanceId);
    await flush(10);
    // 让窗口占有列表多出一个没有槽位的内容，使快照构造抛 unowned 错误。
    const listWindowOwned = coordinator.listWindowOwned.bind(coordinator);
    const ghost = { kind: "pty", slotId: "ghost" } as const;
    const spy = vi
      .spyOn(coordinator, "listWindowOwned")
      .mockImplementation(() => [...listWindowOwned(), ghost]);
    const savedBefore = host.backend.saved.length;
    const paneId = listWorkspacePanes(host.ctx().tree)[0].id;

    await act(async () => {
      host!.ctx().focusPane(paneId);
      host!.ctx().splitPane(paneId, "horizontal");
    });
    await flush(10);

    const invalid = consoleError.mock.calls.filter(
      ([message]) => message === "[workspace.layout_snapshot_invalid]",
    );
    expect(invalid.length).toBeGreaterThanOrEqual(1);
    expect(host.ctx().layoutSaveError).not.toBeNull();
    // 非法快照不会被保存，窗口也没有卸载。
    expect(host.backend.saved).toHaveLength(savedBefore);
    expect(host.errors).toEqual([]);
    expect(screen.queryByText("host crashed")).toBeNull();
    // 这是预期内的诊断日志，清掉后 afterEach 的“从未发生”断言才对其他情形有效。
    consoleError.mockClear();

    spy.mockRestore();
    const secondPaneId = listWorkspacePanes(host.ctx().tree)[0].id;
    await act(async () => {
      host!.ctx().focusPane(secondPaneId);
      host!.ctx().splitPane(secondPaneId, "vertical");
    });
    await flush(10);

    // 下一次状态变化自愈：保存恢复，错误提示消失。
    expect(host.backend.saved.length).toBeGreaterThan(savedBefore);
    expect(host.ctx().layoutSaveError).toBeNull();
    expect(
      listWorkspacePanes(
        host.backend.saved[host.backend.saved.length - 1].layout.tree,
      ),
    ).toHaveLength(3);
    expect(host.errors).toEqual([]);
  });
});

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
import { resetFakeTerminals, toastSpy } from "../test/host/hostMocks";
import { assertWorkspaceInvariants } from "../test/host/workspaceInvariants";
import {
  detachFileToWindow,
  detachPtyToWindow,
  emitBackendEvent,
  emitToMain,
  flush,
  invokes,
  launchPty,
  mountWorkspace,
  openFile,
  savedLayouts,
  type WorkspaceHost,
} from "../test/host/workspaceHarness";
import { listWorkspacePanes } from "../lib/ptyWorkspaceLayout";
import { PTY_OWNER_LOST_MAX_ATTEMPTS } from "../lib/ptyOwnerLostRecovery";
import { WorkspaceContentCoordinator } from "../lib/workspaceContentCoordinator";

let host: WorkspaceHost | undefined;
afterEach(async () => {
  errorSpy?.mockRestore();
  errorSpy = undefined;
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

const LOST_EVENT = "workspace-content-window-lost";

function fileOccurrences(target: WorkspaceHost, documentId: string) {
  return listWorkspacePanes(target.ctx().tree)
    .flatMap((pane) => pane.contents)
    .filter(
      (content) => content.kind === "file" && content.documentId === documentId,
    ).length;
}

/** 文件分离到独立窗，并让窗口把一份尚未保存的编辑镜像回主窗口。 */
async function detachWithMirroredEdit(target: WorkspaceHost, path = "a.txt") {
  const doc = await openFile(target, path);
  const detached = await detachFileToWindow(target, doc.id);
  await emitToMain("workspace-file-window-buffer-changed", {
    documentId: doc.id,
    token: detached.token,
    windowLabel: detached.windowLabel,
    fileDocument: doc,
    fileBuffer: {
      ...detached.initBuffer,
      content: "mirror",
      version: detached.initBuffer.version + 1,
    },
  });
  await flush();
  return { doc, ...detached };
}

/** 本文件用例内安装的 console.error 静音 spy；只在 afterEach 中恢复它，不影响 tauriMock 的 vi.fn。 */
let errorSpy: { mockRestore: () => void } | undefined;

describe("detached window loss", () => {
  it("rehomes a file whose standalone window was destroyed and keeps its mirrored buffer dirty", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    const { doc, windowLabel } = await detachWithMirroredEdit(host);
    const paneId = listWorkspacePanes(host.ctx().tree)[0].id;
    const openCallsBefore = invokes("open_project_file").length;
    const savesBefore = savedLayouts(host).length;

    tauriMock.destroyWindow(windowLabel);
    await emitBackendEvent(LOST_EVENT, { windowLabel });
    await flush();

    const focusedPane = listWorkspacePanes(host.ctx().tree)[0];
    expect(focusedPane.contents).toContainEqual({
      kind: "file",
      documentId: doc.id,
    });
    expect(host.ctx().detachedFileIds.has(doc.id)).toBe(false);
    const buffer = host.ctx().fileBuffers[doc.id];
    expect(buffer.content).toBe("mirror");
    expect(buffer.content).not.toBe(buffer.savedContent);
    expect(savedLayouts(host).length).toBeGreaterThan(savesBefore);
    expect(
      savedLayouts(host)[savedLayouts(host).length - 1].layout.detachedContents,
    ).toEqual([]);
    expect(coordinator.get({ kind: "file", documentId: doc.id })).toMatchObject(
      {
        phase: "attached",
        owner: { kind: "pane", windowLabel: "main", paneId },
      },
    );
    expect(() => assertWorkspaceInvariants(host!)).not.toThrow();
    // 反向断言：回收不重新读盘，也不是一次“正常返回”。
    expect(invokes("open_project_file").length).toBe(openCallsBefore);
    expect(
      tauriMock.state.emittedEvents.some(
        (event) =>
          (event.payload as { type?: string }).type ===
          "workspace-file-window-return-complete",
      ),
    ).toBe(false);
    expect(host.errors).toEqual([]);
  });

  it("ignores a lost event for a window that already returned its file", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    const doc = await openFile(host);
    const pane = listWorkspacePanes(host.ctx().tree)[0];
    const { token, windowLabel, initBuffer } = await detachFileToWindow(
      host,
      doc.id,
    );
    await emitToMain("workspace-file-window-return-requested", {
      documentId: doc.id,
      token,
      windowLabel,
      targetPaneId: pane.id,
      fileDocument: doc,
      fileBuffer: {
        ...initBuffer,
        content: "edited in window",
        version: initBuffer.version + 1,
      },
    });
    await flush(10);
    // 前置状态：返回已经完成（文件在树中恰好 1 次且已回到 attached），再去触发窗口销毁。
    expect(fileOccurrences(host, doc.id)).toBe(1);
    expect(coordinator.get({ kind: "file", documentId: doc.id })?.phase).toBe(
      "attached",
    );
    const treeBefore = host.ctx().tree;
    const savesBefore = savedLayouts(host).length;
    const bufferBefore = host.ctx().fileBuffers[doc.id];

    tauriMock.destroyWindow(windowLabel);
    await emitBackendEvent(LOST_EVENT, { windowLabel });
    await flush(10);

    // 同一引用：没有树提交。
    expect(host.ctx().tree).toBe(treeBefore);
    expect(fileOccurrences(host, doc.id)).toBe(1);
    expect(coordinator.get({ kind: "file", documentId: doc.id })?.phase).toBe(
      "attached",
    );
    expect(savedLayouts(host).length).toBe(savesBefore);
    expect(host.ctx().fileBuffers[doc.id]).toBe(bufferBefore);
    expect(() => assertWorkspaceInvariants(host!)).not.toThrow();
    expect(host.errors).toEqual([]);
  });

  it("ignores a lost event for an unrelated window label", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    const doc = await openFile(host);
    const { windowLabel } = await detachFileToWindow(host, doc.id);
    await flush(10);
    const treeBefore = host.ctx().tree;
    const savesBefore = savedLayouts(host).length;

    for (const unrelated of [
      "workspace-content-00000000-0000-4000-8000-000000000000",
      "terminal-00000000-0000-4000-8000-000000000000",
      "main",
    ]) {
      await emitBackendEvent(LOST_EVENT, { windowLabel: unrelated });
      await flush(5);
    }

    expect(host.ctx().tree).toBe(treeBefore);
    expect(coordinator.get({ kind: "file", documentId: doc.id })).toMatchObject(
      {
        phase: "detached",
        owner: { kind: "window", windowLabel },
      },
    );
    expect(host.ctx().detachedFileIds.has(doc.id)).toBe(true);
    expect(savedLayouts(host).length).toBe(savesBefore);
    expect(() => assertWorkspaceInvariants(host!)).not.toThrow();
    // 反向断言：回收是被动的，不会再销毁任何窗口。
    expect(
      tauriMock.state.windowActions.some((entry) => entry.action === "destroy"),
    ).toBe(false);
    expect(host.errors).toEqual([]);
  });

  it("handles a duplicate lost event once", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    const { doc, windowLabel } = await detachWithMirroredEdit(host);

    tauriMock.destroyWindow(windowLabel);
    await emitBackendEvent(LOST_EVENT, { windowLabel });
    await flush(5);
    const savesAfterFirst = savedLayouts(host).length;
    await emitBackendEvent(LOST_EVENT, { windowLabel });
    await flush(5);

    expect(fileOccurrences(host, doc.id)).toBe(1);
    expect(savedLayouts(host).length).toBe(savesAfterFirst);
    expect(() => assertWorkspaceInvariants(host!)).not.toThrow();
    expect(host.errors).toEqual([]);
  });

  it("ignores a lost event while the file is still detaching and leaves recovery to the start timeout", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    const doc = await openFile(host);
    const content = { kind: "file", documentId: doc.id } as const;
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "Date",
      ],
    });
    let rejection: unknown;
    await act(async () => {
      void host!
        .ctx()
        .detachFile(doc.id)
        .catch((reason: unknown) => {
          rejection = reason;
        });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const windowLabel =
      tauriMock.state.createdWindows[tauriMock.state.createdWindows.length - 1]
        .label;
    expect(coordinator.get(content)?.phase).toBe("detaching");

    // 窗口在握手完成前崩溃：020 的回收只处理 detached，这里必须被忽略。
    tauriMock.destroyWindow(windowLabel);
    await emitBackendEvent(LOST_EVENT, { windowLabel });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(coordinator.get(content)?.phase).toBe("detaching");
    expect(fileOccurrences(host, doc.id)).toBe(1);
    expect(rejection).toBeUndefined();

    // 兜底：启动超时把文件回滚到 pane，没有永久停在 detaching。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain("pty.detachedStartTimedOut");
    expect(coordinator.get(content)?.phase).toBe("attached");
    expect(fileOccurrences(host, doc.id)).toBe(1);
    expect(host.ctx().detachedFileIds.has(doc.id)).toBe(false);
    expect(() => assertWorkspaceInvariants(host!)).not.toThrow();
    expect(host.errors).toEqual([]);
  });
});

function ptyOccurrences(target: WorkspaceHost, instanceId: string) {
  return listWorkspacePanes(target.ctx().tree)
    .flatMap((pane) => pane.contents)
    .filter(
      (content) => content.kind === "pty" && content.slotId === instanceId,
    ).length;
}

const FAKE_TIMERS = [
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "Date",
] as const;

/** 子窗口的 label：子窗口在 detachSession 之后才创建，所以总是惰性读取。 */
function lastChildLabel() {
  const created = tauriMock.state.createdWindows;
  return created[created.length - 1].label;
}

function destroyedChild(label: string) {
  return tauriMock.state.windowActions.some(
    (action) => action.windowLabel === label && action.action === "destroy",
  );
}

/** 以 Rust 的原始 DTO 形态设置状态查询的返回值（不是映射后的 { state, ownerLabel }）。 */
function reportStatus(
  target: WorkspaceHost,
  report: () => { status: string; ownerWindowLabel: string | null },
) {
  target.backend.handlers.set("get_pty_session_window_status", report);
}

/** fake timers 下开始一次分离：子窗口永远不发 ready，等待 15 秒超时对账。 */
async function startUnacknowledgedDetach(
  target: WorkspaceHost,
  instanceId: string,
) {
  vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
  const outcome: {
    settled: "pending" | "resolved" | "rejected";
    rejection: unknown;
  } = { settled: "pending", rejection: undefined };
  await act(async () => {
    void target
      .ctx()
      .detachSession(instanceId)
      .then(
        () => {
          outcome.settled = "resolved";
        },
        (reason: unknown) => {
          outcome.settled = "rejected";
          outcome.rejection = reason;
        },
      );
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  return outcome;
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

describe("PTY detach timeout reconciliation", () => {
  it("does not accept a detach when Rust reports a foreign owner", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    const { slot } = await launchPty(host);
    const outcome = await startUnacknowledgedDetach(host, slot.instanceId);
    const child = lastChildLabel();
    reportStatus(host, () => ({
      status: "ownedByAnotherWindow",
      ownerWindowLabel: "terminal-8e783338-f464-4b10-b15e-b534748c6241",
    }));

    await advance(15_000);

    expect(host.ctx().detachedInstanceIds.has(slot.instanceId)).toBe(false);
    expect(destroyedChild(child)).toBe(true);
    expect(outcome.rejection).toBeInstanceOf(Error);
    expect((outcome.rejection as Error).message).toContain(
      "pty.detachedStateChanged",
    );
    expect(ptyOccurrences(host, slot.instanceId)).toBe(1);
    expect(
      coordinator.get({ kind: "pty", slotId: slot.instanceId })?.phase,
    ).toBe("attached");
    // 反向断言：没有走 accept 分支（槽位没有离开树），宿主没有报错。
    expect(host.errors).toEqual([]);
  });

  it.each(["ownedByAnotherWindow", "running", "ended"] as const)(
    "reconciles a timed-out detach when Rust reports %s",
    async (reported) => {
      const coordinator = new WorkspaceContentCoordinator();
      host = await mountWorkspace({ coordinator });
      const { slot, terminal } = await launchPty(host);
      const outcome = await startUnacknowledgedDetach(host, slot.instanceId);
      const child = lastChildLabel();
      reportStatus(host, () =>
        reported === "ownedByAnotherWindow"
          ? { status: reported, ownerWindowLabel: lastChildLabel() }
          : reported === "running"
            ? { status: reported, ownerWindowLabel: "main" }
            : { status: reported, ownerWindowLabel: null },
      );

      await advance(15_000);

      if (reported === "ownedByAnotherWindow") {
        expect(host.ctx().detachedInstanceIds.has(slot.instanceId)).toBe(true);
        expect(ptyOccurrences(host, slot.instanceId)).toBe(0);
        expect(outcome.settled).toBe("resolved");
      } else if (reported === "running") {
        // 规格写的是“恰好 1 次”，但 reconcileTimedOutDetach 的回退路径与
        // detachSession 的 catch 各回滚一次（既有的重复回滚，Rust 侧幂等）。
        // 用户 2026-10-09 批准放宽为“至少 1 次且令牌全部相同”，缺陷登记给 m6-026。
        const cancelTokens = terminal.cancelHandoff.mock.calls.map(
          (call) => call[0],
        );
        expect(cancelTokens.length).toBeGreaterThanOrEqual(1);
        expect(new Set(cancelTokens).size).toBe(1);
        expect(cancelTokens[0]).toMatch(/^handoff-/);
        expect(ptyOccurrences(host, slot.instanceId)).toBe(1);
        expect(destroyedChild(child)).toBe(true);
        expect((outcome.rejection as Error).message).toContain(
          "pty.detachedStartTimedOut",
        );
        // 反向断言：不得出现“窗口被接受为 detached”。
        expect(host.ctx().detachedInstanceIds.has(slot.instanceId)).toBe(false);
      } else {
        expect(host.ctx().slots).toEqual([]);
        expect(destroyedChild(child)).toBe(true);
        expect((outcome.rejection as Error).message).toContain(
          "pty.detachedStartFailed",
        );
      }
      expect(host.errors).toEqual([]);
    },
  );

  // 配对的普通用例：只断言上限之内的重试行为，与下面的“放弃并回滚”用例互补。
  it("keeps querying the owner every second while the status query fails", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    const { slot } = await launchPty(host);
    const outcome = await startUnacknowledgedDetach(host, slot.instanceId);
    reportStatus(host, () => {
      throw new Error("status unavailable");
    });
    const before = invokes("get_pty_session_window_status").length;

    await advance(18_000);

    expect(
      invokes("get_pty_session_window_status").length - before,
    ).toBeGreaterThanOrEqual(3);
    expect(ptyOccurrences(host, slot.instanceId)).toBe(1);
    expect(
      coordinator.get({ kind: "pty", slotId: slot.instanceId })?.phase,
    ).toBe("detaching");
    expect(outcome.settled).toBe("pending");
    expect(host.errors).toEqual([]);
  });

  it("gives up reconciling after the retry limit and rolls the detach back", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    const { slot, terminal } = await launchPty(host);
    const outcome = await startUnacknowledgedDetach(host, slot.instanceId);
    const child = lastChildLabel();
    reportStatus(host, () => {
      throw new Error("status unavailable");
    });

    await advance(25_000);

    expect(destroyedChild(child)).toBe(true);
    expect(terminal.cancelHandoff).toHaveBeenCalled();
    expect(outcome.rejection).toBeInstanceOf(Error);
    expect(vi.getTimerCount()).toBe(0);
    expect(ptyOccurrences(host, slot.instanceId)).toBe(1);
  });

  it("stops reconciling after unmount", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    const { slot } = await launchPty(host);
    await startUnacknowledgedDetach(host, slot.instanceId);
    reportStatus(host, () => {
      throw new Error("status unavailable");
    });
    await advance(16_000);
    // 反向断言：卸载之前对账确实在查询（否则下面的“不再增加”是空转）。
    expect(invokes("get_pty_session_window_status").length).toBeGreaterThan(0);

    const hostErrors = host.errors;
    host.dispose();
    host = undefined;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(vi.getTimerCount()).toBe(0);
    const atDispose = invokes("get_pty_session_window_status").length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(invokes("get_pty_session_window_status").length).toBe(atDispose);
    expect(hostErrors).toEqual([]);
  });
});

const OWNER_LOST_EVENT = "pty-session-owner-lost";
const FOREIGN_TERMINAL = "terminal-8e783338-f464-4b10-b15e-b534748c6241";

/** 挂载工作区，启动一个 PTY 并分离到子窗口；返回槽位、假终端和子窗口 label。 */
async function detachedPtyHost(
  status: { status: string; ownerWindowLabel: string | null },
  options: { listenerRetryDelaysMs?: readonly number[]; strict?: boolean } = {},
) {
  const coordinator = new WorkspaceContentCoordinator();
  host = await mountWorkspace({ coordinator, ...options });
  const { slot, terminal } = await launchPty(host);
  const { windowLabel } = await detachPtyToWindow(host, slot.instanceId);
  host.backend.handlers.set("get_pty_session_window_status", () => status);
  return { coordinator, slot, terminal, windowLabel };
}

describe("PTY owner-lost recovery", () => {
  it("retries reattach a bounded number of times and reports failure once", async () => {
    toastSpy.error.mockClear();
    const { slot, terminal } = await detachedPtyHost({
      status: "running",
      ownerWindowLabel: "main",
    });
    terminal.reattachLostSession.mockRejectedValue(new Error("not yet"));
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });

    await emitBackendEvent(OWNER_LOST_EVENT, { sessionId: slot.sessionId });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(terminal.reattachLostSession.mock.calls.length).toBe(
      PTY_OWNER_LOST_MAX_ATTEMPTS,
    );
    expect(toastSpy.error).toHaveBeenCalledTimes(1);
    expect(String(toastSpy.error.mock.calls[0][0])).toContain(
      "pty.ownerLostRecoveryFailed",
    );
    expect(vi.getTimerCount()).toBe(0);
    expect(host!.errors).toEqual([]);
  });

  it("still retries a bounded number of times after StrictMode remounts the provider", async () => {
    toastSpy.error.mockClear();
    const { slot, terminal } = await detachedPtyHost(
      { status: "running", ownerWindowLabel: "main" },
      { strict: true },
    );
    terminal.reattachLostSession.mockRejectedValue(new Error("not yet"));
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });

    await emitBackendEvent(OWNER_LOST_EVENT, { sessionId: slot.sessionId });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    // 生命周期控制器若在严格模式的二次挂载后仍处于中止状态，这里会是 0 次。
    expect(terminal.reattachLostSession.mock.calls.length).toBe(
      PTY_OWNER_LOST_MAX_ATTEMPTS,
    );
    expect(toastSpy.error).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops scheduling retries after the workspace unmounts", async () => {
    toastSpy.error.mockClear();
    const { slot, terminal } = await detachedPtyHost({
      status: "running",
      ownerWindowLabel: "main",
    });
    terminal.reattachLostSession.mockRejectedValue(new Error("not yet"));
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });

    await emitBackendEvent(OWNER_LOST_EVENT, { sessionId: slot.sessionId });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    const callsBeforeDispose = terminal.reattachLostSession.mock.calls.length;
    host!.dispose();
    host = undefined;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(vi.getTimerCount()).toBe(0);
    expect(terminal.reattachLostSession.mock.calls.length).toBe(
      callsBeforeDispose,
    );
    expect(toastSpy.error).not.toHaveBeenCalled();
  });

  it("returns the reclaimed PTY to the focused pane after a successful reattach", async () => {
    toastSpy.error.mockClear();
    const { slot, terminal, windowLabel } = await detachedPtyHost({
      status: "running",
      ownerWindowLabel: "main",
    });
    terminal.reattachLostSession.mockResolvedValue(undefined);

    await emitBackendEvent(OWNER_LOST_EVENT, { sessionId: slot.sessionId });
    await flush();

    const focused = listWorkspacePanes(host!.ctx().tree).find(
      (pane) => pane.id === host!.ctx().focusedPaneId,
    );
    expect(focused?.contents).toContainEqual({
      kind: "pty",
      slotId: slot.instanceId,
    });
    expect(host!.ctx().detachedInstanceIds.has(slot.instanceId)).toBe(false);
    expect(
      tauriMock.state.windowActions.some(
        (action) =>
          action.windowLabel === windowLabel && action.action === "destroy",
      ),
    ).toBe(true);
    expect(terminal.reattachLostSession).toHaveBeenCalledTimes(1);
    expect(terminal.reattachLostSession).toHaveBeenCalledWith(slot.sessionId);
    expect(() => assertWorkspaceInvariants(host!)).not.toThrow();
    expect(toastSpy.error).not.toHaveBeenCalled();
  });

  it("ignores a second owner-lost event while a recovery loop is running", async () => {
    toastSpy.error.mockClear();
    const { slot, terminal } = await detachedPtyHost({
      status: "running",
      ownerWindowLabel: "main",
    });
    terminal.reattachLostSession.mockRejectedValue(new Error("not yet"));
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });

    await act(async () => {
      tauriMock.emitEvent(
        OWNER_LOST_EVENT,
        { sessionId: slot.sessionId },
        "main",
      );
      tauriMock.emitEvent(
        OWNER_LOST_EVENT,
        { sessionId: slot.sessionId },
        "main",
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(terminal.reattachLostSession).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(terminal.reattachLostSession).toHaveBeenCalledTimes(
      PTY_OWNER_LOST_MAX_ATTEMPTS,
    );
    expect(toastSpy.error).toHaveBeenCalledTimes(1);
  });

  it("stops retrying when another window now owns the session", async () => {
    toastSpy.error.mockClear();
    const { slot, terminal } = await detachedPtyHost({
      status: "ownedByAnotherWindow",
      ownerWindowLabel: FOREIGN_TERMINAL,
    });
    terminal.reattachLostSession.mockRejectedValue(new Error("not yet"));
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });

    await emitBackendEvent(OWNER_LOST_EVENT, { sessionId: slot.sessionId });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(terminal.reattachLostSession).toHaveBeenCalledTimes(1);
    expect(toastSpy.error).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    // 反向断言：别的窗口持有时不得移除槽位。
    expect(
      host!
        .ctx()
        .slots.some((candidate) => candidate.instanceId === slot.instanceId),
    ).toBe(true);
  });

  it("removes the slot and stops when the session already ended", async () => {
    toastSpy.error.mockClear();
    const { slot, terminal } = await detachedPtyHost({
      status: "ended",
      ownerWindowLabel: null,
    });
    terminal.reattachLostSession.mockRejectedValue(new Error("gone"));
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });

    await emitBackendEvent(OWNER_LOST_EVENT, { sessionId: slot.sessionId });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(
      host!
        .ctx()
        .slots.some((candidate) => candidate.instanceId === slot.instanceId),
    ).toBe(false);
    expect(terminal.reattachLostSession).toHaveBeenCalledTimes(1);
    expect(toastSpy.error).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("workspace listener isolation", () => {
  it("keeps PTY handoff listeners when the owner-lost listener fails to register and surfaces the failure", async () => {
    toastSpy.error.mockClear();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      tauriMock.failNextListen(
        OWNER_LOST_EVENT,
        new Error("event.listen not allowed"),
      );
    }
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator, listenerRetryDelaysMs: [0, 0] });
    const { slot } = await launchPty(host);

    const { detachPromise } = await detachPtyToWindow(host, slot.instanceId);
    await detachPromise;

    expect(host.ctx().detachedInstanceIds.has(slot.instanceId)).toBe(true);
    expect(toastSpy.error).toHaveBeenCalledTimes(1);
    const message = String(toastSpy.error.mock.calls[0][0]);
    expect(message).toContain("pty.listenerSetupFailed");
    expect(message).toContain(OWNER_LOST_EVENT);
    expect(() => assertWorkspaceInvariants(host!)).not.toThrow();
    expect(host.errors).toEqual([]);
  });
});

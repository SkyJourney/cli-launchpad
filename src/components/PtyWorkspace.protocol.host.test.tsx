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
import { assertWorkspaceInvariants } from "../test/host/workspaceInvariants";
import {
  detachFileToWindow,
  detachPtyToWindow,
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
import { WORKSPACE_CONTENT_WINDOW_EVENT } from "../lib/workspaceContentWindowProtocol";
import { WorkspaceContentCoordinator } from "../lib/workspaceContentCoordinator";
import { getWorkspaceContentAdapter } from "./workspaceContentAdapterRegistry";
import type { WorkspacePaneContentRef } from "../lib/tauri";

let host: WorkspaceHost | undefined;
/** 文件适配器 prepareHandoff 的监视器；每个用例结束都恢复，避免污染共享的适配器注册表。 */
let filePrepareSpy: { mockRestore: () => void } | undefined;
afterEach(async () => {
  filePrepareSpy?.mockRestore();
  filePrepareSpy = undefined;
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

/** 某内容在整棵树中出现的次数。 */
function occurrences(target: WorkspaceHost, wanted: WorkspacePaneContentRef) {
  return listWorkspacePanes(target.ctx().tree)
    .flatMap((pane) => pane.contents)
    .filter((content) => {
      if (content.kind !== wanted.kind) return false;
      if (content.kind === "file" && wanted.kind === "file") {
        return content.documentId === wanted.documentId;
      }
      if (content.kind === "pty" && wanted.kind === "pty") {
        return content.slotId === wanted.slotId;
      }
      return false;
    }).length;
}

/** 发往指定窗口、协议类型为 type 的事件记录。 */
function eventsTo(windowLabel: string, type: string) {
  return tauriMock.state.emittedEvents.filter(
    (event) =>
      event.target === windowLabel &&
      (event.payload as { type?: string }).type === type,
  );
}

function lastCreatedWindow() {
  const created =
    tauriMock.state.createdWindows[tauriMock.state.createdWindows.length - 1];
  if (!created) throw new Error("no window was created");
  const url = new URL(
    (created.options as { url: string }).url,
    "http://localhost",
  );
  return {
    label: created.label,
    token: url.searchParams.get("fileHandoffToken") ?? "",
  };
}

describe("duplicate and out-of-order handoff events", () => {
  it("ignores a second pty-detached-ready", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    const { slot } = await launchPty(host);
    await act(async () => {
      void host!
        .ctx()
        .detachSession(slot.instanceId)
        .catch(() => undefined);
    });
    await flush();
    const created = lastCreatedWindow();
    expect(created.label.startsWith("terminal-")).toBe(true);
    const readyPayload = {
      instanceId: slot.instanceId,
      sessionId: slot.sessionId,
      windowLabel: created.label,
    };
    await emitToMain("pty-detached-ready", readyPayload);
    await flush();
    const savesAfterFirst = savedLayouts(host).length;

    await emitToMain("pty-detached-ready", readyPayload);
    await flush();

    expect(tauriMock.state.createdWindows).toHaveLength(1);
    // 第二次 ready 没有再次提交树。
    expect(savedLayouts(host).length).toBe(savesAfterFirst);
    expect(occurrences(host, { kind: "pty", slotId: slot.instanceId })).toBe(0);
    expect(
      coordinator.get({ kind: "pty", slotId: slot.instanceId }),
    ).toMatchObject({
      phase: "detached",
      owner: { kind: "window", windowLabel: created.label },
    });
    expect(() => assertWorkspaceInvariants(host!)).not.toThrow();
    expect(host.errors).toEqual([]);
  });

  it("ignores a file attached event that arrives before ready/init", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    const doc = await openFile(host);
    const content = { kind: "file", documentId: doc.id } as const;
    // 手工驱动分离：不能用 detachFileToWindow（它会自动发 ready 与 attached）。
    let settled: "pending" | "resolved" | "rejected" = "pending";
    await act(async () => {
      void host!
        .ctx()
        .detachFile(doc.id)
        .then(
          () => {
            settled = "resolved";
          },
          () => {
            settled = "rejected";
          },
        );
    });
    await flush();
    const { label: windowLabel, token } = lastCreatedWindow();
    const attachedPayload = { documentId: doc.id, token, windowLabel };

    // 步骤 A：attached 先于 ready（乱序或伪造）。
    await emitToMain("workspace-file-window-attached", attachedPayload);
    await flush();
    expect(occurrences(host, content)).toBe(1);
    expect(coordinator.get(content)?.phase).toBe("detaching");
    expect(settled).toBe("pending");
    // detaching 属于窗口拥有阶段，由 coordinator 派生。
    expect(host.ctx().detachedFileIds.has(doc.id)).toBe(true);
    // 反向断言：init 只在步骤 B 的 ready 之后才会发出。
    expect(eventsTo(windowLabel, "workspace-file-window-init")).toHaveLength(0);

    // 步骤 B：补发 ready 之后，合法的 attached 仍能完成分离。
    await emitToMain("workspace-file-window-ready", attachedPayload);
    await flush();
    expect(eventsTo(windowLabel, "workspace-file-window-init")).toHaveLength(1);
    await emitToMain("workspace-file-window-attached", attachedPayload);
    await flush();
    expect(coordinator.get(content)?.phase).toBe("detached");
    expect(settled).toBe("resolved");
    expect(occurrences(host, content)).toBe(0);
    expect(() => assertWorkspaceInvariants(host!)).not.toThrow();
    expect(
      tauriMock.state.windowActions.some((entry) => entry.action === "destroy"),
    ).toBe(false);
    expect(host.errors).toEqual([]);
  });

  it("ignores a ready that arrives after the detach timed out", async () => {
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
    const { label: windowLabel, token } = lastCreatedWindow();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    await emitToMain("workspace-file-window-ready", {
      documentId: doc.id,
      token,
      windowLabel,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(occurrences(host, content)).toBe(1);
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain("pty.detachedStartTimedOut");
    expect(invokes("revoke_content_window_file")).toHaveLength(1);
    expect(coordinator.get(content)?.phase).toBe("attached");
    expect(() => assertWorkspaceInvariants(host!)).not.toThrow();
    // 反向断言：超时之后迟到的 ready 不会触发 init。
    expect(eventsTo(windowLabel, "workspace-file-window-init")).toHaveLength(0);
    expect(host.errors).toEqual([]);
  });

  it("ignores a late attach-failed after attached", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    const doc = await openFile(host);
    const { token, windowLabel } = await detachFileToWindow(host, doc.id);
    const treeBefore = host.ctx().tree;
    const savesBefore = savedLayouts(host).length;

    await emitToMain("workspace-file-window-attach-failed", {
      documentId: doc.id,
      token,
      windowLabel,
      message: "late failure",
    });
    await flush();

    expect(coordinator.get({ kind: "file", documentId: doc.id })).toMatchObject(
      {
        phase: "detached",
        owner: { kind: "window", windowLabel },
      },
    );
    expect(host.ctx().detachedFileIds.has(doc.id)).toBe(true);
    expect(host.ctx().tree).toBe(treeBefore);
    expect(savedLayouts(host).length).toBe(savesBefore);
    expect(() => assertWorkspaceInvariants(host!)).not.toThrow();
    // 反向断言：迟到的失败不会销毁已经交接成功的窗口。
    expect(
      tauriMock.state.windowActions.some(
        (entry) =>
          entry.windowLabel === windowLabel && entry.action === "destroy",
      ),
    ).toBe(false);
    expect(host.errors).toEqual([]);
  });

  /** 文件与 PTY 都已分离到各自的窗口，返回请求的载荷也一并准备好。 */
  async function detachFileAndPty(coordinator: WorkspaceContentCoordinator) {
    host = await mountWorkspace({ coordinator });
    const doc = await openFile(host);
    const paneId = listWorkspacePanes(host.ctx().tree)[0].id;
    const {
      token,
      windowLabel: fileLabel,
      initBuffer,
    } = await detachFileToWindow(host, doc.id);
    const { slot, terminal } = await launchPty(host);
    const { windowLabel: ptyLabel } = await detachPtyToWindow(
      host,
      slot.instanceId,
    );
    const fileReturn = {
      documentId: doc.id,
      token,
      windowLabel: fileLabel,
      targetPaneId: paneId,
      fileDocument: doc,
      fileBuffer: {
        ...initBuffer,
        content: "back",
        version: initBuffer.version + 1,
      },
    };
    const ptyReturn = {
      instanceId: slot.instanceId,
      sessionId: slot.sessionId,
      windowLabel: ptyLabel,
      token: "return-1",
    };
    return { doc, slot, terminal, fileLabel, ptyLabel, fileReturn, ptyReturn };
  }

  /**
   * 在同一个 act 内同步派发：emitToMain 自带 act，会让第一次请求在第二次发出前就完成，
   * 那是“返回完成之后的重复请求”（非目标）；这里要让第二次落在第一次尚未完成的时刻。
   */
  async function dispatchTogether(
    requests: ReadonlyArray<readonly [string, unknown]>,
  ) {
    await act(async () => {
      for (const [type, payload] of requests) {
        tauriMock.emitEvent(
          WORKSPACE_CONTENT_WINDOW_EVENT,
          { apiVersion: 1, type, payload },
          "main",
        );
      }
    });
    await flush(10);
  }

  it("handles a duplicate file return request once", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    const { doc, slot, fileLabel, fileReturn } =
      await detachFileAndPty(coordinator);

    await dispatchTogether([
      ["workspace-file-window-return-requested", fileReturn],
      ["workspace-file-window-return-requested", fileReturn],
    ]);

    expect(
      eventsTo(fileLabel, "workspace-file-window-return-complete"),
    ).toHaveLength(1);
    expect(invokes("revoke_content_window_file")).toHaveLength(1);
    expect(occurrences(host!, { kind: "file", documentId: doc.id })).toBe(1);
    expect(coordinator.get({ kind: "file", documentId: doc.id })?.phase).toBe(
      "attached",
    );
    // 反向断言：没有发出返回请求的 PTY 仍留在它的窗口里。
    expect(occurrences(host!, { kind: "pty", slotId: slot.instanceId })).toBe(
      0,
    );
    expect(
      eventsTo(fileLabel, "workspace-file-window-return-failed"),
    ).toHaveLength(0);
    expect(() => assertWorkspaceInvariants(host!)).not.toThrow();
    expect(host!.errors).toEqual([]);
  });

  it("handles a duplicate pty return request once", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    const { doc, slot, terminal, ptyLabel, ptyReturn } =
      await detachFileAndPty(coordinator);

    await dispatchTogether([
      ["pty-return-requested", ptyReturn],
      ["pty-return-requested", ptyReturn],
    ]);

    expect(terminal.attachHandoff).toHaveBeenCalledTimes(1);
    expect(occurrences(host!, { kind: "pty", slotId: slot.instanceId })).toBe(
      1,
    );
    expect(
      coordinator.get({ kind: "pty", slotId: slot.instanceId })?.phase,
    ).toBe("attached");
    // 反向断言：没有发出返回请求的文件仍留在它的窗口里。
    expect(occurrences(host!, { kind: "file", documentId: doc.id })).toBe(0);
    expect(
      tauriMock.state.emittedEvents.some(
        (event) =>
          event.target === ptyLabel &&
          (event.payload as { type?: string }).type === "pty-return-failed",
      ),
    ).toBe(false);
    expect(() => assertWorkspaceInvariants(host!)).not.toThrow();
    expect(host!.errors).toEqual([]);
  });

  // 与下面的 it.fails 共用同一组并发请求，但只断言“当前确实成立”的非缺陷事实：
  // 副作用没有重复。这样 it.fails 不会掩盖这些行为的回归，afterEach 的泄漏断言也照常生效。
  it("does not repeat return effects when file and pty return requests are duplicated", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    const { terminal, fileLabel, ptyLabel, fileReturn, ptyReturn } =
      await detachFileAndPty(coordinator);

    await dispatchTogether([
      ["workspace-file-window-return-requested", fileReturn],
      ["workspace-file-window-return-requested", fileReturn],
      ["pty-return-requested", ptyReturn],
      ["pty-return-requested", ptyReturn],
    ]);

    expect(terminal.attachHandoff).toHaveBeenCalledTimes(1);
    expect(
      eventsTo(fileLabel, "workspace-file-window-return-complete"),
    ).toHaveLength(1);
    expect(invokes("revoke_content_window_file")).toHaveLength(1);
    // 反向断言：重复请求没有产生任何返回失败事件。
    expect(
      eventsTo(fileLabel, "workspace-file-window-return-failed"),
    ).toHaveLength(0);
    expect(
      tauriMock.state.emittedEvents.some(
        (event) =>
          event.target === ptyLabel &&
          (event.payload as { type?: string }).type === "pty-return-failed",
      ),
    ).toBe(false);
    expect(host!.errors).toEqual([]);
  });

  // 待修复 m6-028（用户 2026-10-08 批准的偏离）：文件返回与 PTY 返回被并发处理时，
  // 后提交的 commitTree 基于陈旧的树快照覆盖了前一个，文件从树里丢失而 coordinator 仍认为
  // 它已 attached（I4 反向违规，并记录 [workspace.layout_snapshot_invalid]）。
  // m6-028 修复后删除 `.fails`，本用例转为正常用例。
  it.fails(
    "handles a duplicate return request for the same token once",
    async () => {
      const coordinator = new WorkspaceContentCoordinator();
      const {
        doc,
        slot,
        terminal,
        fileLabel,
        ptyLabel,
        fileReturn,
        ptyReturn,
      } = await detachFileAndPty(coordinator);

      await dispatchTogether([
        ["workspace-file-window-return-requested", fileReturn],
        ["workspace-file-window-return-requested", fileReturn],
        ["pty-return-requested", ptyReturn],
        ["pty-return-requested", ptyReturn],
      ]);

      expect(terminal.attachHandoff).toHaveBeenCalledTimes(1);
      expect(
        eventsTo(fileLabel, "workspace-file-window-return-complete"),
      ).toHaveLength(1);
      expect(invokes("revoke_content_window_file")).toHaveLength(1);
      expect(occurrences(host!, { kind: "file", documentId: doc.id })).toBe(1);
      expect(occurrences(host!, { kind: "pty", slotId: slot.instanceId })).toBe(
        1,
      );
      expect(() => assertWorkspaceInvariants(host!)).not.toThrow();
      // 反向断言：重复请求没有产生任何返回失败事件。
      expect(
        eventsTo(fileLabel, "workspace-file-window-return-failed"),
      ).toHaveLength(0);
      expect(
        tauriMock.state.emittedEvents.some(
          (event) =>
            event.target === ptyLabel &&
            (event.payload as { type?: string }).type === "pty-return-failed",
        ),
      ).toBe(false);
      expect(host!.errors).toEqual([]);
    },
  );

  /**
   * 手工驱动文件分离到“窗口已创建”（不能用 detachFileToWindow：它会自动发 ready 与 attached），
   * 返回协议载荷与 init 发送计数函数。
   */
  async function beginManualFileDetach(
    coordinator: WorkspaceContentCoordinator,
  ) {
    host = await mountWorkspace({ coordinator });
    const doc = await openFile(host);
    const state = { settled: "pending" as "pending" | "resolved" | "rejected" };
    await act(async () => {
      void host!
        .ctx()
        .detachFile(doc.id)
        .then(
          () => {
            state.settled = "resolved";
          },
          () => {
            state.settled = "rejected";
          },
        );
    });
    await flush();
    const { label: windowLabel, token } = lastCreatedWindow();
    const payload = { documentId: doc.id, token, windowLabel };
    const initEmits = () =>
      eventsTo(windowLabel, "workspace-file-window-init").length;
    // 重复的 ready 不得让主窗口重复 prepare（会覆盖 pending 的 handoffContext/handoffPayload，
    // prepare 失败时还会误毁已经在进行的交接）。
    const lifecycle = getWorkspaceContentAdapter("file").lifecycle as {
      prepareHandoff: (...args: unknown[]) => unknown;
    };
    const spy = vi.spyOn(lifecycle, "prepareHandoff");
    filePrepareSpy = spy;
    const prepareCalls = () => spy.mock.calls.length;
    return { doc, state, windowLabel, payload, initEmits, prepareCalls };
  }

  it("ignores a second workspace-file-window-ready after the init was sent", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    const { doc, state, windowLabel, payload, initEmits, prepareCalls } =
      await beginManualFileDetach(coordinator);
    const content = { kind: "file", documentId: doc.id } as const;

    await emitToMain("workspace-file-window-ready", payload);
    await flush();
    const afterFirst = initEmits();
    expect(afterFirst).toBe(1);

    await emitToMain("workspace-file-window-ready", payload);
    await flush();

    expect(initEmits()).toBe(1);
    expect(prepareCalls()).toBe(1);
    expect(coordinator.get(content)?.phase).toBe("detaching");
    expect(state.settled).toBe("pending");

    await emitToMain("workspace-file-window-attached", payload);
    await flush();
    expect(coordinator.get(content)?.phase).toBe("detached");
    expect(state.settled).toBe("resolved");
    expect(occurrences(host!, content)).toBe(0);
    expect(() => assertWorkspaceInvariants(host!)).not.toThrow();
    // 反向断言：重复的 ready 没有触发失败回滚或销毁窗口。
    expect(
      eventsTo(windowLabel, "workspace-file-window-attach-failed"),
    ).toHaveLength(0);
    expect(
      tauriMock.state.emittedEvents.some(
        (event) =>
          (event.payload as { type?: string }).type ===
          "workspace-file-window-attach-failed",
      ),
    ).toBe(false);
    expect(
      tauriMock.state.windowActions.some((entry) => entry.action === "destroy"),
    ).toBe(false);
    expect(host!.errors).toEqual([]);
  });

  it("ignores a duplicate workspace-file-window-ready that arrives while the first is still preparing", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    const { doc, state, windowLabel, payload, initEmits, prepareCalls } =
      await beginManualFileDetach(coordinator);
    const content = { kind: "file", documentId: doc.id } as const;

    // 两次 ready 在同一个 act 内同步派发（文档备选写法：emitToMain 自带 act，
    // 会让第一次在第二次发出前完成），第二次落在第一次 await prepare 期间。
    await dispatchTogether([
      ["workspace-file-window-ready", payload],
      ["workspace-file-window-ready", payload],
    ]);

    expect(initEmits()).toBe(1);
    expect(prepareCalls()).toBe(1);
    expect(coordinator.get(content)?.phase).toBe("detaching");

    await emitToMain("workspace-file-window-attached", payload);
    await flush();
    expect(coordinator.get(content)?.phase).toBe("detached");
    expect(state.settled).toBe("resolved");
    // 反向断言：没有 attach-failed，没有销毁窗口。
    expect(
      tauriMock.state.emittedEvents.some(
        (event) =>
          (event.payload as { type?: string }).type ===
          "workspace-file-window-attach-failed",
      ),
    ).toBe(false);
    expect(
      tauriMock.state.windowActions.some(
        (entry) =>
          entry.windowLabel === windowLabel && entry.action === "destroy",
      ),
    ).toBe(false);
    expect(host!.errors).toEqual([]);
  });
});

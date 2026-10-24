// @vitest-environment jsdom
import {
  toGenericMessage,
  type LegacyHandoffName,
} from "../test/host/handoffVocabulary";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
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
import { fakeTerminals, resetFakeTerminals } from "../test/host/hostMocks";
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
  relayedHandoffs,
} from "../test/host/workspaceHarness";
import { listWorkspacePanes } from "../lib/ptyWorkspaceLayout";
import { RUST_EVENTS } from "../lib/eventNames";
import { WorkspaceContentCoordinator } from "../lib/workspaceContentCoordinator";
import {
  encodeWorkspaceContentDrag,
  WORKSPACE_CONTENT_DRAG_TYPE,
} from "../lib/workspaceContentDrag";
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
  return relayedHandoffs().filter(
    (event) => event.target === windowLabel && event.legacyType === type,
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
    expect(host.ctx().isDetachedContent({ kind: "file", documentId: doc.id })).toBe(true);
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
    expect(host.ctx().isDetachedContent({ kind: "file", documentId: doc.id })).toBe(true);
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
      handoffToken: "rust-return-1",
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
        // A child window speaks for itself: Rust stamps the sender it claims.
        const claimed =
          (payload as { windowLabel?: string } | null)?.windowLabel ?? "main";
        const message = toGenericMessage(type as LegacyHandoffName, payload);
        tauriMock.deliverInbox(
          "main",
          RUST_EVENTS.windowMessage,
          { apiVersion: 1, type: message.type, payload: message.payload },
          {
            label: claimed,
            kind: claimed.startsWith("terminal-")
              ? "terminal"
              : "workspaceContent",
          },
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
      relayedHandoffs().some(
        (event) =>
          event.target === ptyLabel && event.legacyType === "pty-return-failed",
      ),
    ).toBe(false);
    expect(() => assertWorkspaceInvariants(host!)).not.toThrow();
    expect(host!.errors).toEqual([]);
  });

  // 与下面的并发用例共用同一组并发请求，但只断言“当前确实成立”的非缺陷事实：
  // 副作用没有重复。这样下面的用例即使回归，这里也能单独定位，afterEach 的泄漏断言也照常生效。
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
      relayedHandoffs().some(
        (event) =>
          event.target === ptyLabel && event.legacyType === "pty-return-failed",
      ),
    ).toBe(false);
    expect(host!.errors).toEqual([]);
  });

  it("handles a duplicate return request for the same token once", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    const { doc, slot, terminal, fileLabel, ptyLabel, fileReturn, ptyReturn } =
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
      relayedHandoffs().some(
        (event) =>
          event.target === ptyLabel && event.legacyType === "pty-return-failed",
      ),
    ).toBe(false);
    expect(host!.errors).toEqual([]);
  });

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

  it("rolls back at once when the init event cannot be delivered", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    const { doc, state, windowLabel, payload } =
      await beginManualFileDetach(coordinator);
    const content = { kind: "file", documentId: doc.id } as const;
    // 只让 init 消息的发送失败，其余消息照常中继。
    tauriMock.failNextWindowMessage(
      "content-handoff-init",
      new Error("init could not be delivered"),
    );
    try {
      await emitToMain("workspace-file-window-ready", payload);
      // 不推进计时器：回滚必须立即发生，而不是等 15 秒超时。
      await flush();

      expect(state.settled).toBe("rejected");
      expect(coordinator.get(content)?.phase).not.toBe("detaching");
      expect(occurrences(host!, content)).toBe(1);
      expect(
        tauriMock.state.windowActions.some(
          (entry) =>
            entry.windowLabel === windowLabel && entry.action === "destroy",
        ),
      ).toBe(true);
      expect(() => assertWorkspaceInvariants(host!)).not.toThrow();
      expect(host!.errors).toEqual([]);
    } finally {
      // The failure is consumed by the send above; nothing else to restore.
    }
  });

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
      relayedHandoffs().some(
        (event) => event.legacyType === "workspace-file-window-attach-failed",
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
      relayedHandoffs().some(
        (event) => event.legacyType === "workspace-file-window-attach-failed",
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

  it("ignores a file return request that arrives after the return completed", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    const { doc, fileLabel, fileReturn } = await detachFileAndPty(coordinator);
    const content = { kind: "file", documentId: doc.id } as const;

    // 第一次返回完整结束之后，才发第二次相同请求（不是并发）。
    await emitToMain("workspace-file-window-return-requested", fileReturn);
    await flush();
    expect(coordinator.get(content)?.phase).toBe("attached");
    expect(
      eventsTo(fileLabel, "workspace-file-window-return-complete"),
    ).toHaveLength(1);
    expect(invokes("revoke_content_window_file")).toHaveLength(1);

    await emitToMain("workspace-file-window-return-requested", fileReturn);
    await flush();

    expect(coordinator.get(content)?.phase).toBe("attached");
    expect(occurrences(host!, content)).toBe(1);
    expect(() => assertWorkspaceInvariants(host!)).not.toThrow();
    expect(
      eventsTo(fileLabel, "workspace-file-window-return-complete"),
    ).toHaveLength(1);
    expect(invokes("revoke_content_window_file")).toHaveLength(1);
    // 反向断言：重复请求没有产生任何返回失败事件。
    expect(
      eventsTo(fileLabel, "workspace-file-window-return-failed"),
    ).toHaveLength(0);
    expect(host!.errors).toEqual([]);
  });

  it("ignores a pty return request that arrives after the return completed", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    const { slot, terminal, ptyLabel, ptyReturn } =
      await detachFileAndPty(coordinator);
    const content = { kind: "pty", slotId: slot.instanceId } as const;

    await emitToMain("pty-return-requested", ptyReturn);
    await flush();
    expect(coordinator.get(content)?.phase).toBe("attached");
    expect(terminal.attachHandoff).toHaveBeenCalledTimes(1);
    // 第一次返回已完整结束：窗口被销毁。
    const destroysOf = () =>
      tauriMock.state.windowActions.filter(
        (entry) => entry.windowLabel === ptyLabel && entry.action === "destroy",
      ).length;
    expect(destroysOf()).toBe(1);
    // 反向断言：销毁成功时不发 pty-return-complete（它只是销毁失败时的兜底）。
    expect(eventsTo(ptyLabel, "pty-return-complete")).toHaveLength(0);

    await emitToMain("pty-return-requested", ptyReturn);
    await flush();

    expect(coordinator.get(content)?.phase).toBe("attached");
    expect(occurrences(host!, content)).toBe(1);
    expect(() => assertWorkspaceInvariants(host!)).not.toThrow();
    expect(terminal.attachHandoff).toHaveBeenCalledTimes(1);
    // 反向断言：重复请求没有再次销毁窗口。
    expect(destroysOf()).toBe(1);
    // 反向断言：没有发往 PTY 窗口的 pty-return-failed，也没有 pty-return-complete。
    expect(eventsTo(ptyLabel, "pty-return-failed")).toHaveLength(0);
    expect(eventsTo(ptyLabel, "pty-return-complete")).toHaveLength(0);
    expect(host!.errors).toEqual([]);
  });
});

describe("untrusted window events", () => {
  const FOREIGN = "workspace-content-11111111-1111-4111-8111-111111111111";
  const FOREIGN_TERMINAL = "terminal-3b9f2c1e-6d4a-4f7b-8a21-5c0e9d7a1b34";

  /** A detached file plus a buffer-changed payload that is accepted when sent as is. */
  async function detachedFileWithBufferChange() {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    const doc = await openFile(host);
    const { token, windowLabel, initBuffer } = await detachFileToWindow(
      host,
      doc.id,
    );
    const changed = (overrides: {
      token?: string;
      windowLabel?: string;
      epoch?: number;
      version?: number;
      content?: string;
    }) => ({
      documentId: doc.id,
      token: overrides.token ?? token,
      windowLabel: overrides.windowLabel ?? windowLabel,
      fileDocument: doc,
      fileBuffer: {
        ...initBuffer,
        content: overrides.content ?? "evil",
        epoch: overrides.epoch ?? initBuffer.epoch,
        version: overrides.version ?? initBuffer.version + 1,
      },
    });
    return { doc, initBuffer, windowLabel, changed };
  }

  it("ignores buffer changes with a foreign token", async () => {
    const { doc, initBuffer, changed } = await detachedFileWithBufferChange();

    await emitToMain(
      "workspace-file-window-buffer-changed",
      changed({ token: "forged" }),
    );
    await flush();

    expect(host!.ctx().fileBuffers[doc.id].content).toBe(initBuffer.content);
    // Reverse: the same change with the real window token is mirrored.
    await emitToMain("workspace-file-window-buffer-changed", changed({}));
    await flush();
    expect(host!.ctx().fileBuffers[doc.id].content).toBe("evil");
    expect(host!.errors).toEqual([]);
  });

  it("ignores buffer changes from another window label", async () => {
    const { doc, initBuffer, changed } = await detachedFileWithBufferChange();

    // The sender is stamped as the other window itself, so only the ownership check can refuse it.
    await emitToMain(
      "workspace-file-window-buffer-changed",
      changed({ windowLabel: FOREIGN }),
    );
    await flush();

    expect(host!.ctx().fileBuffers[doc.id].content).toBe(initBuffer.content);
    // Reverse: the owning window's change is mirrored.
    await emitToMain("workspace-file-window-buffer-changed", changed({}));
    await flush();
    expect(host!.ctx().fileBuffers[doc.id].content).toBe("evil");
    expect(host!.errors).toEqual([]);
  });

  it("ignores older buffer epochs and versions", async () => {
    const { doc, initBuffer, changed } = await detachedFileWithBufferChange();
    // Mirror a newer buffer first, so "older" is measured against something above the init buffer.
    await emitToMain(
      "workspace-file-window-buffer-changed",
      changed({ content: "newest", version: initBuffer.version + 5 }),
    );
    await flush();
    expect(host!.ctx().fileBuffers[doc.id].content).toBe("newest");

    // An older version of the same epoch.
    await emitToMain(
      "workspace-file-window-buffer-changed",
      changed({ content: "stale-version", version: initBuffer.version + 4 }),
    );
    await flush();
    expect(host!.ctx().fileBuffers[doc.id].content).toBe("newest");
    // The same version is not newer either.
    await emitToMain(
      "workspace-file-window-buffer-changed",
      changed({ content: "same-version", version: initBuffer.version + 5 }),
    );
    await flush();
    expect(host!.ctx().fileBuffers[doc.id].content).toBe("newest");

    // A higher epoch wins even with a lower version.
    await emitToMain(
      "workspace-file-window-buffer-changed",
      changed({
        content: "newer-epoch",
        epoch: initBuffer.epoch + 1,
        version: 0,
      }),
    );
    await flush();
    expect(host!.ctx().fileBuffers[doc.id].content).toBe("newer-epoch");
    await emitToMain(
      "workspace-file-window-buffer-changed",
      changed({
        content: "stale-epoch",
        epoch: initBuffer.epoch,
        version: initBuffer.version + 50,
      }),
    );
    await flush();
    // Reverse: the higher epoch stays, even against a much higher version of the older epoch.
    expect(host!.ctx().fileBuffers[doc.id].content).toBe("newer-epoch");
    expect(host!.errors).toEqual([]);
  });

  it("rejects a PTY return requested by a non-owner terminal", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    const { slot } = await launchPty(host);
    const { windowLabel } = await detachPtyToWindow(host, slot.instanceId);
    const request = (label: string, token: string) => ({
      instanceId: slot.instanceId,
      sessionId: slot.sessionId,
      windowLabel: label,
      token,
      handoffToken: `rust-${token}`,
    });

    // The terminal speaks for itself (stamped as itself), but it does not own this PTY.
    await emitToMain(
      "pty-return-requested",
      request(FOREIGN_TERMINAL, "intruder-1"),
    );
    await flush();

    const failed = eventsTo(FOREIGN_TERMINAL, "pty-return-failed");
    expect(failed).toHaveLength(1);
    expect(
      String((failed[0].payload as { message?: string }).message),
    ).toContain("pty.detachedSessionMissing");
    expect(host.ctx().isDetachedContent({ kind: "pty", slotId: slot.instanceId })).toBe(true);
    expect(eventsTo(windowLabel, "pty-return-complete")).toHaveLength(0);
    expect(eventsTo(windowLabel, "pty-return-failed")).toHaveLength(0);
    // Reverse: the owning terminal's request still returns the PTY.
    await emitToMain("pty-return-requested", request(windowLabel, "owner-1"));
    await flush();
    expect(host.ctx().isDetachedContent({ kind: "pty", slotId: slot.instanceId })).toBe(false);
    expect(host.errors).toEqual([]);
  });

  it("ignores a file buffer change whose stamped sender is not the claimed window", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    const doc = await openFile(host);
    const { token, windowLabel, initBuffer } = await detachFileToWindow(
      host,
      doc.id,
    );
    const payload = {
      documentId: doc.id,
      token,
      windowLabel,
      fileDocument: doc,
      fileBuffer: {
        ...initBuffer,
        content: "evil",
        version: initBuffer.version + 1,
      },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    // Another window stamped as the sender: the claim of `windowLabel` is not trusted.
    await emitToMain("workspace-file-window-buffer-changed", payload, {
      source: FOREIGN,
    });
    await flush();

    expect(host.ctx().fileBuffers[doc.id].content).toBe(initBuffer.content);
    expect(warn).toHaveBeenCalledWith(
      "workspace_content_event.source_mismatch",
      "content-handoff-state-changed",
    );
    // Reverse: the same payload from the window it claims is accepted.
    await emitToMain("workspace-file-window-buffer-changed", payload);
    await flush();
    expect(host.ctx().fileBuffers[doc.id].content).toBe("evil");
    expect(host.errors).toEqual([]);
    warn.mockRestore();
  });

  it("ignores a PTY return request whose stamped sender is not the claimed terminal", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    const { slot } = await launchPty(host);
    const { windowLabel } = await detachPtyToWindow(host, slot.instanceId);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const request = {
      instanceId: slot.instanceId,
      sessionId: slot.sessionId,
      windowLabel,
      token: "return-1",
      handoffToken: "rust-return-1",
    };
    const repliesTo = () =>
      tauriMock.state.relayedMessages.filter(
        (message) =>
          message.target === windowLabel &&
          (message.messageType === "pty-return-complete" ||
            message.messageType === "pty-return-failed"),
      );

    await emitToMain("pty-return-requested", request, {
      source: FOREIGN_TERMINAL,
    });
    await flush();

    expect(host.ctx().isDetachedContent({ kind: "pty", slotId: slot.instanceId })).toBe(true);
    expect(repliesTo()).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      "workspace_content_event.source_mismatch",
      "content-handoff-return-requested",
    );
    // Reverse: without a forged sender the request is processed.
    await emitToMain("pty-return-requested", request);
    await flush();
    expect(host.ctx().isDetachedContent({ kind: "pty", slotId: slot.instanceId })).toBe(false);
    expect(host.errors).toEqual([]);
    warn.mockRestore();
  });

  it("ignores a file return request whose stamped sender is not the claimed window", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    const doc = await openFile(host);
    const content = { kind: "file", documentId: doc.id } as const;
    const paneId = listWorkspacePanes(host.ctx().tree)[0].id;
    const { token, windowLabel, initBuffer } = await detachFileToWindow(
      host,
      doc.id,
    );
    const request = {
      documentId: doc.id,
      token,
      windowLabel,
      targetPaneId: paneId,
      fileDocument: doc,
      fileBuffer: {
        ...initBuffer,
        content: "back",
        version: initBuffer.version + 1,
      },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await emitToMain("workspace-file-window-return-requested", request, {
      source: FOREIGN,
    });
    await flush();

    expect(coordinator.get(content)?.phase).toBe("detached");
    expect(occurrences(host, content)).toBe(0);
    expect(invokes("revoke_content_window_file")).toHaveLength(0);
    // The forged request gets no answer at all: neither complete nor failed.
    expect(
      eventsTo(windowLabel, "workspace-file-window-return-complete"),
    ).toHaveLength(0);
    expect(
      eventsTo(windowLabel, "workspace-file-window-return-failed"),
    ).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      "workspace_content_event.source_mismatch",
      "content-handoff-return-requested",
    );
    // Reverse: the same request from the window it claims is processed.
    await emitToMain("workspace-file-window-return-requested", request);
    await flush();
    expect(coordinator.get(content)?.phase).toBe("attached");
    expect(occurrences(host, content)).toBe(1);
    expect(
      eventsTo(windowLabel, "workspace-file-window-return-complete"),
    ).toHaveLength(1);
    expect(() => assertWorkspaceInvariants(host!)).not.toThrow();
    expect(host.errors).toEqual([]);
    warn.mockRestore();
  });

  /** Drives a file detach up to "window created", then lets the test speak for the child. */
  async function beginFileDetach(coordinator: WorkspaceContentCoordinator) {
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
    return {
      doc,
      state,
      windowLabel,
      payload: { documentId: doc.id, token, windowLabel },
    };
  }

  it("ignores a file window ready whose stamped sender is not the claimed window", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    const { doc, state, windowLabel, payload } =
      await beginFileDetach(coordinator);
    const content = { kind: "file", documentId: doc.id } as const;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await emitToMain("workspace-file-window-ready", payload, {
      source: FOREIGN,
    });
    await flush();

    // No init is sent to a window whose ready was forged.
    expect(eventsTo(windowLabel, "workspace-file-window-init")).toHaveLength(0);
    expect(coordinator.get(content)?.phase).toBe("detaching");
    expect(state.settled).toBe("pending");
    expect(warn).toHaveBeenCalledWith(
      "workspace_content_event.source_mismatch",
      expect.any(String),
    );
    // Reverse: the genuine ready still starts the handoff.
    await emitToMain("workspace-file-window-ready", payload);
    await flush();
    expect(eventsTo(windowLabel, "workspace-file-window-init")).toHaveLength(1);
    expect(host!.errors).toEqual([]);
    warn.mockRestore();
  });

  it("ignores a file window attached whose stamped sender is not the claimed window", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    const { doc, state, windowLabel, payload } =
      await beginFileDetach(coordinator);
    const content = { kind: "file", documentId: doc.id } as const;
    await emitToMain("workspace-file-window-ready", payload);
    await flush();
    expect(eventsTo(windowLabel, "workspace-file-window-init")).toHaveLength(1);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await emitToMain("workspace-file-window-attached", payload, {
      source: FOREIGN,
    });
    await flush();

    // The forged acknowledgement must not complete the detach.
    expect(coordinator.get(content)?.phase).toBe("detaching");
    expect(state.settled).toBe("pending");
    expect(occurrences(host!, content)).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      "workspace_content_event.source_mismatch",
      expect.any(String),
    );
    // Reverse: the genuine acknowledgement completes it.
    await emitToMain("workspace-file-window-attached", payload);
    await flush();
    expect(coordinator.get(content)?.phase).toBe("detached");
    expect(state.settled).toBe("resolved");
    expect(occurrences(host!, content)).toBe(0);
    expect(() => assertWorkspaceInvariants(host!)).not.toThrow();
    expect(host!.errors).toEqual([]);
    warn.mockRestore();
  });

  it("rejects a file return whose document identity changed", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    const doc = await openFile(host);
    const content = { kind: "file", documentId: doc.id } as const;
    const paneId = listWorkspacePanes(host.ctx().tree)[0].id;
    const { token, windowLabel, initBuffer } = await detachFileToWindow(
      host,
      doc.id,
    );
    const request = {
      documentId: doc.id,
      token,
      windowLabel,
      targetPaneId: paneId,
      fileDocument: doc,
      fileBuffer: {
        ...initBuffer,
        content: "back",
        version: initBuffer.version + 1,
      },
    };

    await emitToMain("workspace-file-window-return-requested", {
      ...request,
      fileDocument: { ...doc, relativePath: "other.txt" },
    });
    await flush();

    const failed = eventsTo(windowLabel, "workspace-file-window-return-failed");
    expect(failed).toHaveLength(1);
    expect(
      String((failed[0].payload as { message?: string }).message),
    ).toContain("pty.returnFailed");
    // The file stays with its window: nothing was merged, revoked or attached.
    expect(coordinator.get(content)?.phase).toBe("detached");
    expect(host.ctx().isDetachedContent({ kind: "file", documentId: doc.id })).toBe(true);
    expect(occurrences(host, content)).toBe(0);
    expect(host.ctx().fileBuffers[doc.id].content).toBe(initBuffer.content);
    expect(invokes("revoke_content_window_file")).toHaveLength(0);
    expect(
      eventsTo(windowLabel, "workspace-file-window-return-complete"),
    ).toHaveLength(0);
    // Reverse: the failure keeps the window token valid, so the genuine request still returns.
    await emitToMain("workspace-file-window-return-requested", request);
    await flush();
    expect(coordinator.get(content)?.phase).toBe("attached");
    expect(occurrences(host, content)).toBe(1);
    expect(host.ctx().fileBuffers[doc.id].content).toBe("back");
    expect(() => assertWorkspaceInvariants(host!)).not.toThrow();
    expect(host.errors).toEqual([]);
  });

  it("ignores drops claiming an unmanaged source window", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    const doc = await openFile(host);
    const content = { kind: "file", documentId: doc.id } as const;
    const [onlyPane] = listWorkspacePanes(host.ctx().tree);
    act(() => {
      host!.ctx().splitPane(onlyPane.id, "horizontal");
    });
    await flush();
    const paneB = listWorkspacePanes(host.ctx().tree).find(
      (pane) => pane.id !== onlyPane.id,
    )!;
    const { windowLabel } = await detachFileToWindow(host, doc.id);
    const dropOn = async (sourceWindowLabel: string) => {
      const store = new Map<string, string>([
        [
          WORKSPACE_CONTENT_DRAG_TYPE,
          encodeWorkspaceContentDrag({
            key: `file:${doc.id}`,
            sourceWindowLabel,
          }),
        ],
      ]);
      const dataTransfer = {
        effectAllowed: "",
        dropEffect: "",
        get types() {
          return [...store.keys()];
        },
        setData: (type: string, value: string) => store.set(type, value),
        getData: (type: string) => store.get(type) ?? "",
      };
      await act(async () => {
        fireEvent.drop(
          screen.getByRole("region", {
            name: `pty.paneNumber:${JSON.stringify({ number: paneB.paneNumber })}`,
          }),
          { dataTransfer },
        );
      });
      await flush();
    };
    const returnDrops = () =>
      relayedHandoffs().filter(
        (event) =>
          event.legacyType === "workspace-file-window-return-drop-requested",
      );

    await dropOn(FOREIGN);

    expect(returnDrops()).toHaveLength(0);
    expect(coordinator.get(content)?.phase).toBe("detached");
    expect(occurrences(host, content)).toBe(0);
    // Reverse: a drop naming the window that really owns the file asks it to return.
    await dropOn(windowLabel);
    expect(returnDrops()).toHaveLength(1);
    expect(returnDrops()[0].target).toBe(windowLabel);
    expect(host.errors).toEqual([]);
  });
});

describe("PTY handoff target", () => {
  it("passes the new terminal window label to captureHandoff when detaching", async () => {
    host = await mountWorkspace();
    const { slot } = await launchPty(host);
    const terminal = fakeTerminals[0];

    const { windowLabel } = await detachPtyToWindow(host, slot.instanceId);

    expect(terminal.captureHandoff).toHaveBeenCalledTimes(1);
    expect(terminal.captureHandoff).toHaveBeenCalledWith(windowLabel);
    // 同一个标签既传给 captureHandoff，也用于创建窗口。
    expect(windowLabel).toBe(tauriMock.state.createdWindows[0].label);
    // 反向：不是 main，也不是 undefined。
    expect(terminal.captureHandoff.mock.calls[0][0]).toMatch(/^terminal-/);
    expect(host.errors).toEqual([]);
  });
});

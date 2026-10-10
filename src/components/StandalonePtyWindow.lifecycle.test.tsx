// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { tauriMock } from "../test/tauriMock";
import {
  DEFAULT_PTY_WINDOW_LABEL,
  createBackend,
  deferred,
  emitToWindow,
  flush,
  mountPtyWindow,
} from "../test/host/workspaceHarness";
import {
  fakeTerminals,
  onFakeTerminalCreated,
  resetFakeTerminals,
} from "../test/host/hostMocks";

// vi.mock 与 react-i18next/sonner/PtyTerminal 的替换与其他宿主测试一致（见 hostMocks 的使用规则）。
import { vi } from "vitest";
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

const LABEL = DEFAULT_PTY_WINDOW_LABEL;
type WindowState = "running" | "ended" | "ownedByAnotherWindow";

// 形态 B：get_pty_session_window_status 返回 DTO（与 src/lib/tauri.ts 的 toPtySessionWindowStatus 一致）。
function statusReply(state: WindowState) {
  return {
    status: state,
    ownerWindowLabel:
      state === "ownedByAnotherWindow"
        ? "main"
        : state === "running"
          ? LABEL
          : null,
  };
}

function backendWithStatus(state: WindowState) {
  const backend = createBackend();
  backend.handlers.set("get_pty_session_window_status", () =>
    statusReply(state),
  );
  return backend;
}

function sentToMain(type: string): unknown[] {
  return tauriMock.state.emittedEvents
    .filter(
      (event) =>
        event.target === "main" &&
        (event.payload as { type?: string }).type === type,
    )
    .map((event) => (event.payload as { payload: unknown }).payload);
}

function destroyCount(): number {
  return tauriMock.state.windowActions.filter(
    (action) => action.windowLabel === LABEL && action.action === "destroy",
  ).length;
}

const disposers: Array<() => void> = [];
afterEach(async () => {
  disposers
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose());
  cleanup();
  resetFakeTerminals();
  vi.useRealTimers();
  await flush();
  expect(tauriMock.state.eventListeners).toHaveLength(0);
});

describe("StandalonePtyWindow lifecycle", () => {
  it("attaches the handoff and reports ready once", async () => {
    const win = await mountPtyWindow({ backend: backendWithStatus("running") });
    disposers.push(win.dispose);
    await flush(10);

    expect(fakeTerminals).toHaveLength(1);
    expect(fakeTerminals[0].attachHandoff).toHaveBeenCalledTimes(1);
    expect(fakeTerminals[0].attachHandoff).toHaveBeenCalledWith(
      "session-1",
      "handoff-1",
    );
    expect(sentToMain("pty-detached-ready")).toEqual([
      { instanceId: "slot-1", sessionId: "session-1", windowLabel: LABEL },
    ]);
    // 反向断言：成功路径不报告失败或退出，也不销毁窗口。
    expect(sentToMain("pty-detached-failed")).toEqual([]);
    expect(sentToMain("pty-detached-exited")).toEqual([]);
    expect(destroyCount()).toBe(0);
    expect(win.errors).toEqual([]);
  });

  it("reports detached-failed and destroys itself when attach fails while main still owns the PTY", async () => {
    onFakeTerminalCreated((handle) => {
      handle.attachHandoff.mockRejectedValueOnce(new Error("attach failed"));
    });
    const win = await mountPtyWindow({ backend: backendWithStatus("running") });
    disposers.push(win.dispose);
    await flush(10);

    const failed = sentToMain("pty-detached-failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      instanceId: "slot-1",
      sessionId: "session-1",
      windowLabel: LABEL,
    });
    expect(String((failed[0] as { message: unknown }).message)).toContain(
      "attach failed",
    );
    expect(destroyCount()).toBe(1);
    expect(document.body.textContent).toContain("attach failed");
    // 反向断言：没有 ready 或 exited。
    expect(sentToMain("pty-detached-ready")).toEqual([]);
    expect(sentToMain("pty-detached-exited")).toEqual([]);
  });

  it("closes as transferred when Rust reports another owner after attach failure", async () => {
    onFakeTerminalCreated((handle) => {
      handle.attachHandoff.mockRejectedValueOnce(new Error("attach failed"));
    });
    const win = await mountPtyWindow({
      backend: backendWithStatus("ownedByAnotherWindow"),
    });
    disposers.push(win.dispose);
    await flush(10);

    expect(destroyCount()).toBe(1);
    // 反向断言：按已转移关闭，不报告 exited，也不报告失败。
    expect(sentToMain("pty-detached-exited")).toEqual([]);
    expect(sentToMain("pty-detached-failed")).toEqual([]);
    expect(sentToMain("pty-detached-ready")).toEqual([]);
  });

  it("sends a return request and destroys itself on the matching return-complete", async () => {
    const win = await mountPtyWindow({ backend: backendWithStatus("running") });
    disposers.push(win.dispose);
    await flush(10);

    fireEvent.click(screen.getByTitle("pty.returnToWorkspace"));
    await flush(10);

    const requested = sentToMain("pty-return-requested");
    expect(requested).toHaveLength(1);
    const token = (requested[0] as { token: string }).token;
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
    expect(destroyCount()).toBe(0);

    await emitToWindow(LABEL, "pty-return-complete", {
      instanceId: "slot-1",
      token,
    });
    await flush(10);

    expect(destroyCount()).toBe(1);
    // 反向断言：成功返回不取消交接，也不报告 aclViolations。
    expect(fakeTerminals[0].cancelHandoff).not.toHaveBeenCalled();
    expect(tauriMock.state.aclViolations).toEqual([]);
  });

  it("ignores a return-failed for a stale token", async () => {
    const win = await mountPtyWindow({ backend: backendWithStatus("running") });
    disposers.push(win.dispose);
    await flush(10);

    fireEvent.click(screen.getByTitle("pty.returnToWorkspace"));
    await flush(10);
    const token = (sentToMain("pty-return-requested")[0] as { token: string })
      .token;

    await emitToWindow(LABEL, "pty-return-failed", {
      instanceId: "slot-1",
      token: "old",
      message: "nope",
    });
    await flush(10);

    expect(
      (screen.getByTitle("pty.returnToWorkspace") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(fakeTerminals[0].cancelHandoff).not.toHaveBeenCalled();
    // 反向断言：过期 token 的失败信息不出现在页面上。
    expect(screen.queryByText(/nope/)).toBeNull();

    // 对照：匹配 token 的失败会解除 returning 并回滚交接。
    await emitToWindow(LABEL, "pty-return-failed", {
      instanceId: "slot-1",
      token,
      message: "real failure",
    });
    await flush(10);

    expect(
      (screen.getByTitle("pty.returnToWorkspace") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(fakeTerminals[0].cancelHandoff).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("real failure");
  });

  it("reports exited when the session ends", async () => {
    const win = await mountPtyWindow({ backend: backendWithStatus("running") });
    disposers.push(win.dispose);
    await flush(10);

    await act(async () => {
      fakeTerminals[0].emitSessionChange({ state: "exited" });
    });
    await flush(10);

    expect(sentToMain("pty-detached-exited")).toEqual([
      { instanceId: "slot-1", sessionId: "session-1", windowLabel: LABEL },
    ]);
    expect(destroyCount()).toBe(1);
    // 反向断言：会话结束不会发起返回请求。
    expect(sentToMain("pty-return-requested")).toEqual([]);
  });

  it("closes and reports exited when closed before ready and Rust says the session ended", async () => {
    const gate = deferred<{ sessionId: string; state: string }>();
    onFakeTerminalCreated((handle) => {
      handle.attachHandoff.mockReturnValueOnce(gate.promise);
    });
    const win = await mountPtyWindow({ backend: backendWithStatus("ended") });
    disposers.push(win.dispose);
    await flush(5);

    await act(async () => {
      tauriMock.emitEvent("tauri://close-requested", {}, LABEL);
    });
    await flush(10);

    expect(sentToMain("pty-detached-exited")).toHaveLength(1);
    expect(destroyCount()).toBe(1);
    // 反向断言：gate 从未 resolve，窗口始终未就绪。
    expect(sentToMain("pty-detached-failed")).toEqual([]);
    expect(sentToMain("pty-return-requested")).toEqual([]);
    expect(sentToMain("pty-detached-ready")).toEqual([]);
  });

  it("reports detached-failed and closes as transferred when closed before ready and another window owns the PTY", async () => {
    const gate = deferred<{ sessionId: string; state: string }>();
    onFakeTerminalCreated((handle) => {
      handle.attachHandoff.mockReturnValueOnce(gate.promise);
    });
    const win = await mountPtyWindow({
      backend: backendWithStatus("ownedByAnotherWindow"),
    });
    disposers.push(win.dispose);
    await flush(5);

    await act(async () => {
      tauriMock.emitEvent("tauri://close-requested", {}, LABEL);
    });
    await flush(10);

    const failed = sentToMain("pty-detached-failed");
    expect(failed).toHaveLength(1);
    expect(String((failed[0] as { message: unknown }).message)).toContain(
      "pty.detachedClosedBeforeReady",
    );
    expect(destroyCount()).toBe(1);
    // 反向断言：不报告 exited，也不发起返回。
    expect(sentToMain("pty-detached-exited")).toEqual([]);
    expect(sentToMain("pty-return-requested")).toEqual([]);
  });

  it("starts a return instead of closing when closed before ready while main still owns the PTY", async () => {
    const gate = deferred<{ sessionId: string; state: string }>();
    onFakeTerminalCreated((handle) => {
      handle.attachHandoff.mockReturnValueOnce(gate.promise);
    });
    const win = await mountPtyWindow({ backend: backendWithStatus("running") });
    disposers.push(win.dispose);
    await flush(5);

    await act(async () => {
      tauriMock.emitEvent("tauri://close-requested", {}, LABEL);
    });
    await flush(10);

    expect(sentToMain("pty-return-requested")).toHaveLength(1);
    expect(destroyCount()).toBe(0);
    // 反向断言：没有 exited 或 failed 上报。
    expect(sentToMain("pty-detached-exited")).toEqual([]);
    expect(sentToMain("pty-detached-failed")).toEqual([]);
  });
});

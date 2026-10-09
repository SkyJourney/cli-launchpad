// @vitest-environment jsdom
import { cleanup } from "@testing-library/react";
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
  DEFAULT_PTY_WINDOW_LABEL,
  flush,
  mountPtyWindow,
} from "../test/host/workspaceHarness";

let windowHandle: Awaited<ReturnType<typeof mountPtyWindow>> | undefined;
afterEach(async () => {
  windowHandle?.dispose();
  windowHandle = undefined;
  cleanup();
  resetFakeTerminals();
  vi.useRealTimers();
  await flush();
  expect(tauriMock.state.eventListeners).toHaveLength(0);
  // ACL 拒绝会被宿主吞掉时用例仍可能通过，所以显式断言没有任何权限违规。
  expect(tauriMock.state.aclViolations).toEqual([]);
});

function emittedEnvelopes(type: string) {
  return tauriMock.state.emittedEvents.filter(
    (event) => (event.payload as { type?: string }).type === type,
  );
}

describe("StandalonePtyWindow listener setup", () => {
  it("reports pty-detached-failed and leaves no listeners when listener registration fails", async () => {
    tauriMock.failNextListen(
      "workspace-content-window-event",
      new Error("denied"),
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    windowHandle = await mountPtyWindow();

    await flush(10);

    const failed = emittedEnvelopes("pty-detached-failed").filter(
      (event) => event.target === "main",
    );
    expect(failed).toHaveLength(1);
    const inner = (failed[0].payload as { payload: { message?: string } })
      .payload;
    expect(inner.message).toContain("denied");
    expect(
      tauriMock.state.windowActions.some(
        (action) =>
          action.windowLabel === DEFAULT_PTY_WINDOW_LABEL &&
          action.action === "destroy",
      ),
    ).toBe(true);
    // 反向断言：没有 ready，窗口 dispose 之后不留任何监听。
    expect(emittedEnvelopes("pty-detached-ready")).toHaveLength(0);
    windowHandle.dispose();
    windowHandle = undefined;
    expect(tauriMock.state.eventListeners).toHaveLength(0);
  });
});

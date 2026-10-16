// @vitest-environment jsdom
import { act, cleanup, fireEvent } from "@testing-library/react";
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
import { flush, mountPtyWindow } from "../test/host/workspaceHarness";

let win: Awaited<ReturnType<typeof mountPtyWindow>> | undefined;
afterEach(async () => {
  win?.dispose();
  win = undefined;
  cleanup();
  resetFakeTerminals();
  await flush();
  expect(tauriMock.state.eventListeners).toHaveLength(0);
  expect(tauriMock.state.aclViolations).toEqual([]);
});

describe("StandalonePtyWindow handoff target", () => {
  it("requests the return handoff for the main window", async () => {
    win = await mountPtyWindow();
    await flush(10);
    const button = document.querySelector<HTMLButtonElement>(
      "button.standalone-pty-return",
    );
    if (!button) throw new Error("return button is not rendered");

    await act(async () => {
      fireEvent.click(button);
    });
    await flush();

    const terminal = fakeTerminals[0];
    expect(terminal.captureHandoff).toHaveBeenCalledTimes(1);
    expect(terminal.captureHandoff).toHaveBeenCalledWith("main");
    // 反向：恰好一个参数，且窗口没有报错。
    expect(terminal.captureHandoff.mock.calls[0]).toHaveLength(1);
    expect(win.errors).toEqual([]);
  });
});

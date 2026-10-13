// @vitest-environment jsdom
import { act, cleanup, createEvent, fireEvent } from "@testing-library/react";
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
import {
  fakeTerminals,
  onFakeTerminalCreated,
  resetFakeTerminals,
} from "../test/host/hostMocks";
import {
  DEFAULT_PTY_WINDOW_LABEL,
  deferred,
  flush,
  mountPtyWindow,
} from "../test/host/workspaceHarness";
import { parseWorkspaceContentDrag } from "../lib/workspaceContentDrag";

const PTY_LABEL = DEFAULT_PTY_WINDOW_LABEL;
const RETURN_TOKEN = "return-token-1";

type PtyWindow = Awaited<ReturnType<typeof mountPtyWindow>>;
let win: PtyWindow | undefined;
let uuidSpy: { mockRestore: () => void } | undefined;

afterEach(async () => {
  win?.dispose();
  win = undefined;
  cleanup();
  resetFakeTerminals();
  uuidSpy?.mockRestore();
  uuidSpy = undefined;
  vi.useRealTimers();
  await flush();
  expect(tauriMock.state.eventListeners).toHaveLength(0);
  expect(tauriMock.state.aclViolations).toEqual([]);
});

async function attachPtyWindow() {
  win = await mountPtyWindow();
  await flush(10);
  return win;
}

/** 让返回请求拿到确定的交接令牌，与 StandalonePtyWindow.i18n.test.tsx 的做法一致。 */
function seedReturnToken() {
  fakeTerminals[0].captureHandoff.mockResolvedValueOnce({
    token: RETURN_TOKEN,
  });
  uuidSpy = vi
    .spyOn(globalThis.crypto, "randomUUID")
    .mockReturnValueOnce(RETURN_TOKEN as ReturnType<typeof crypto.randomUUID>);
}

function returnButton() {
  const button = document.querySelector<HTMLButtonElement>(
    "button.standalone-pty-return",
  );
  if (!button) throw new Error("return button is not rendered");
  return button;
}

function dragSource() {
  const element = document.querySelector<HTMLElement>("[draggable]");
  if (!element) throw new Error("draggable element is not rendered");
  return element;
}

function emittedOfType(type: string) {
  return tauriMock.state.emittedEvents.filter(
    (event) => (event.payload as { type?: string }).type === type,
  );
}

describe("pty window", () => {
  it("shows a return timeout error and re-enables the return button after 15 seconds", async () => {
    await attachPtyWindow();
    seedReturnToken();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    await act(async () => {
      fireEvent.click(returnButton());
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(emittedOfType("pty-return-requested")).toHaveLength(1);
    expect(returnButton().textContent).toContain("pty.returningToWorkspace");

    // 反向：14_999 毫秒时错误还没有出现。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(14_999);
    });
    expect(document.body.textContent).not.toContain("pty.returnFailed");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(document.body.textContent).toContain("pty.returnFailed");
    expect(document.body.textContent).toContain("pty.returnTimedOut");
    expect(returnButton().textContent).toContain("pty.returnToWorkspace");
    expect(returnButton().disabled).toBe(false);
  });

  it("writes the content drag payload only when the window is ready and not returning", async () => {
    // 挂起握手，使窗口在拖动时处于未就绪状态（挂载本身会 flush，不挂起则已就绪）。
    const attach = deferred<{ sessionId: string; state: string }>();
    onFakeTerminalCreated((handle) => {
      handle.attachHandoff.mockImplementationOnce(() => attach.promise);
    });
    win = await mountPtyWindow();
    await flush(5);

    // 未就绪：不写载荷，并阻止拖动。
    const notReady = { effectAllowed: "", setData: vi.fn() };
    const blocked = createEvent.dragStart(dragSource(), {
      dataTransfer: notReady,
    });
    fireEvent(dragSource(), blocked);
    expect(notReady.setData).not.toHaveBeenCalled();
    expect(blocked.defaultPrevented).toBe(true);

    attach.resolve({ sessionId: "session-1", state: "running" });
    await flush(10);

    const ready = { effectAllowed: "", setData: vi.fn() };
    fireEvent.dragStart(dragSource(), { dataTransfer: ready });
    expect(ready.effectAllowed).toBe("move");
    // 本用例不断言旧的 PTY 拖放载荷（由 m6-052 删除）。
    const workspaceWrites = ready.setData.mock.calls.filter(
      ([type]) => type === "application/x-cli-launchpad-workspace-content",
    ) as Array<[string, string]>;
    const plainWrites = ready.setData.mock.calls.filter(
      ([type]) => type === "text/plain",
    ) as Array<[string, string]>;
    expect(workspaceWrites).toHaveLength(1);
    expect(plainWrites).toHaveLength(1);
    expect(plainWrites[0][1]).toBe(workspaceWrites[0][1]);
    expect(parseWorkspaceContentDrag(workspaceWrites[0][1])).toEqual({
      key: "pty:slot-1",
      sourceWindowLabel: PTY_LABEL,
    });

    // 返回中：再次拖动被阻止，且不再写入工作区载荷。
    seedReturnToken();
    await act(async () => {
      fireEvent.click(returnButton());
    });
    await flush();
    const returning = { effectAllowed: "", setData: vi.fn() };
    const returningEvent = createEvent.dragStart(dragSource(), {
      dataTransfer: returning,
    });
    fireEvent(dragSource(), returningEvent);
    expect(returningEvent.defaultPrevented).toBe(true);
    expect(
      returning.setData.mock.calls.filter(
        ([type]) => type === "application/x-cli-launchpad-workspace-content",
      ),
    ).toHaveLength(0);
  });

  it("removes every listener when the pty window unmounts", async () => {
    const attached = await attachPtyWindow();
    expect(tauriMock.state.eventListeners.length).toBeGreaterThan(0);

    attached.dispose();
    await flush();

    expect(tauriMock.state.eventListeners).toHaveLength(0);
    expect(attached.errors).toEqual([]);
  });
});

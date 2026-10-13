// @vitest-environment jsdom
import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "react-i18next",
  async () => (await import("../test/host/hostMocks")).reactI18nextMock,
);
vi.mock(
  "sonner",
  async () => (await import("../test/host/hostMocks")).sonnerMock,
);

import { tauriMock } from "../test/tauriMock";
import { resetFakeTerminals } from "../test/host/hostMocks";
import {
  DEFAULT_FILE_WINDOW_LABEL,
  emitToWindow,
  flush,
  mountFileWindow,
} from "../test/host/workspaceHarness";
import { parseWorkspaceContentDrag } from "../lib/workspaceContentDrag";

const FILE_LABEL = DEFAULT_FILE_WINDOW_LABEL;
const INIT = {
  documentId: "doc-1",
  token: "tok-1",
  windowLabel: FILE_LABEL,
  fileDocument: {
    id: "doc-1",
    directoryId: 1,
    directoryPath: "C:/project",
    relativePath: "a.txt",
  },
  fileBuffer: {
    kind: "text",
    epoch: 0,
    version: 0,
    content: "hello",
    savedContent: "hello",
    revision: "r1",
    saving: false,
    conflict: false,
  },
};

type FileWindow = Awaited<ReturnType<typeof mountFileWindow>>;
let win: FileWindow | undefined;

afterEach(async () => {
  win?.dispose();
  win = undefined;
  cleanup();
  resetFakeTerminals();
  vi.useRealTimers();
  await flush();
  expect(tauriMock.state.eventListeners).toHaveLength(0);
  expect(tauriMock.state.aclViolations).toEqual([]);
});

function emittedOfType(type: string) {
  return tauriMock.state.emittedEvents.filter(
    (event) => (event.payload as { type?: string }).type === type,
  );
}

function returnButton() {
  return screen.getByTitle("pty.returnToWorkspace") as HTMLButtonElement;
}

function dragSource() {
  const element = document.querySelector<HTMLElement>("[draggable]");
  if (!element) throw new Error("draggable element is not rendered");
  return element;
}

async function attachFileWindow() {
  win = await mountFileWindow();
  await flush();
  await emitToWindow(FILE_LABEL, "workspace-file-window-init", INIT);
  await flush();
  return win;
}

describe("file window", () => {
  it("reports closed-before-ready and destroys itself when closed before init", async () => {
    win = await mountFileWindow();
    await flush();

    await act(async () => {
      tauriMock.emitEvent("tauri://close-requested", {}, FILE_LABEL);
    });
    await flush();

    const failed = emittedOfType("workspace-file-window-attach-failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].target).toBe("main");
    expect(
      (failed[0].payload as { payload: { reason: string } }).payload.reason,
    ).toBe("closed-before-ready");
    expect(tauriMock.state.windowActions).toContainEqual(
      expect.objectContaining({ windowLabel: FILE_LABEL, action: "destroy" }),
    );
    expect(
      emittedOfType("workspace-file-window-return-requested"),
    ).toHaveLength(0);
  });

  it("shows a return timeout error and re-enables the return button after 15 seconds", async () => {
    await attachFileWindow();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    await act(async () => {
      fireEvent.click(returnButton());
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(
      emittedOfType("workspace-file-window-return-requested"),
    ).toHaveLength(1);
    expect(returnButton().disabled).toBe(true);

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
    expect(returnButton().disabled).toBe(false);
  });

  it("writes the content drag payload only when the window is ready", async () => {
    win = await mountFileWindow();
    await flush();

    // 未就绪：不写载荷，并阻止拖动。
    const notReady = { effectAllowed: "", setData: vi.fn() };
    const blocked = createEvent.dragStart(dragSource(), {
      dataTransfer: notReady,
    });
    fireEvent(dragSource(), blocked);
    expect(notReady.setData).not.toHaveBeenCalled();
    expect(blocked.defaultPrevented).toBe(true);

    await emitToWindow(FILE_LABEL, "workspace-file-window-init", INIT);
    await flush();

    const ready = { effectAllowed: "", setData: vi.fn() };
    fireEvent.dragStart(dragSource(), { dataTransfer: ready });
    expect(ready.effectAllowed).toBe("move");
    expect(ready.setData).toHaveBeenCalledTimes(2);
    const [[type, payload], [plainType, plainPayload]] = ready.setData.mock
      .calls as Array<[string, string]>;
    expect(type).toBe("application/x-cli-launchpad-workspace-content");
    expect(plainType).toBe("text/plain");
    expect(plainPayload).toBe(payload);
    expect(parseWorkspaceContentDrag(payload)).toEqual({
      kind: "file",
      contentId: "doc-1",
      sourceWindowLabel: FILE_LABEL,
    });
  });

  it("removes every listener when the file window unmounts", async () => {
    const attached = await attachFileWindow();
    expect(tauriMock.state.eventListeners.length).toBeGreaterThan(0);

    attached.dispose();
    await flush();

    expect(tauriMock.state.eventListeners).toHaveLength(0);
    expect(attached.errors).toEqual([]);
  });
});

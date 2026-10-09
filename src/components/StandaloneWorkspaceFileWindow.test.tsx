// @vitest-environment jsdom
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

import { tauriMock } from "../test/tauriMock";
import { resetFakeTerminals } from "../test/host/hostMocks";
import {
  DEFAULT_FILE_WINDOW_LABEL,
  emitToWindow,
  flush,
  mountFileWindow,
} from "../test/host/workspaceHarness";

const LABEL = DEFAULT_FILE_WINDOW_LABEL;
const FOREIGN_LABEL = "workspace-content-00000000-0000-4000-8000-000000000000";
const INIT = {
  documentId: "doc-1",
  token: "tok-1",
  windowLabel: LABEL,
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
  },
};

let windowHandle: Awaited<ReturnType<typeof mountFileWindow>> | undefined;
afterEach(async () => {
  windowHandle?.dispose();
  windowHandle = undefined;
  cleanup();
  resetFakeTerminals();
  vi.useRealTimers();
  await flush();
  expect(tauriMock.state.eventListeners).toHaveLength(0);
  expect(tauriMock.state.aclViolations).toEqual([]);
});

function emittedEnvelopes(type: string) {
  return tauriMock.state.emittedEvents.filter(
    (event) => (event.payload as { type?: string }).type === type,
  );
}

async function mountAttached() {
  windowHandle = await mountFileWindow();
  await flush();
  await emitToWindow(LABEL, "workspace-file-window-init", INIT);
  await flush();
  return windowHandle;
}

describe("StandaloneWorkspaceFileWindow", () => {
  it("attaches the init payload and acknowledges attached", async () => {
    await mountAttached();

    expect((screen.getByLabelText("editor") as HTMLTextAreaElement).value).toBe(
      "hello",
    );
    const attached = emittedEnvelopes("workspace-file-window-attached");
    expect(attached).toHaveLength(1);
    expect(attached[0].target).toBe("main");
    expect(emittedEnvelopes("workspace-file-window-attach-failed")).toEqual([]);
    expect(windowHandle!.errors).toEqual([]);
  });

  it("ignores init with a foreign token or label", async () => {
    windowHandle = await mountFileWindow();
    await flush();

    await emitToWindow(LABEL, "workspace-file-window-init", {
      ...INIT,
      token: "other-token",
    });
    await flush();
    await emitToWindow(LABEL, "workspace-file-window-init", {
      ...INIT,
      windowLabel: FOREIGN_LABEL,
    });
    await flush();

    expect(screen.queryByLabelText("editor")).toBeNull();
    expect(emittedEnvelopes("workspace-file-window-attached")).toEqual([]);

    // 反向断言：监听仍然存活，正确的 init 照常生效。
    await emitToWindow(LABEL, "workspace-file-window-init", INIT);
    await flush();
    expect(screen.getByLabelText("editor")).toBeTruthy();
    expect(emittedEnvelopes("workspace-file-window-attached")).toHaveLength(1);
  });

  it("answers flush requests with the current buffer", async () => {
    await mountAttached();
    fireEvent.change(screen.getByLabelText("editor"), {
      target: { value: "edited" },
    });
    await flush();

    await emitToWindow(LABEL, "workspace-file-window-flush-requested", {
      documentId: "doc-1",
      token: "tok-1",
      windowLabel: LABEL,
      requestId: "req-1",
    });
    await flush();

    const complete = emittedEnvelopes("workspace-file-window-flush-complete");
    expect(complete).toHaveLength(1);
    const payload = (
      complete[0].payload as {
        payload: { requestId: string; fileBuffer: { content: string } };
      }
    ).payload;
    expect(payload.requestId).toBe("req-1");
    expect(payload.fileBuffer.content).toBe("edited");

    // 反向断言：token 不符的请求不产生第二条应答。
    await emitToWindow(LABEL, "workspace-file-window-flush-requested", {
      documentId: "doc-1",
      token: "other-token",
      windowLabel: LABEL,
      requestId: "req-2",
    });
    await flush();
    expect(
      emittedEnvelopes("workspace-file-window-flush-complete"),
    ).toHaveLength(1);
  });

  it("routes a native close after ready to a return request", async () => {
    await mountAttached();
    fireEvent.change(screen.getByLabelText("editor"), {
      target: { value: "closing edit" },
    });
    await flush();

    await act(async () => {
      tauriMock.emitEvent("tauri://close-requested", {}, LABEL);
    });
    await flush(10);

    const requested = emittedEnvelopes(
      "workspace-file-window-return-requested",
    );
    expect(requested).toHaveLength(1);
    const payload = (
      requested[0].payload as {
        payload: { documentId: string; fileBuffer: { content: string } };
      }
    ).payload;
    expect(payload.documentId).toBe("doc-1");
    expect(payload.fileBuffer.content).toBe("closing edit");
    // 销毁要等 return-complete。
    expect(tauriMock.state.windowActions).not.toContainEqual(
      expect.objectContaining({ windowLabel: LABEL, action: "destroy" }),
    );
  });

  it("resets returning on return-failed and destroys on return-complete", async () => {
    await mountAttached();
    const returnButton = () =>
      screen.getByRole("button", {
        name: /pty\.returnToWorkspace/,
      }) as HTMLButtonElement;

    fireEvent.click(returnButton());
    await flush(10);
    expect(returnButton().disabled).toBe(true);

    await emitToWindow(LABEL, "workspace-file-window-return-failed", {
      documentId: "doc-1",
      token: "tok-1",
      windowLabel: LABEL,
      message: "failed",
    });
    await flush();
    expect(returnButton().disabled).toBe(false);
    expect(tauriMock.state.windowActions).not.toContainEqual(
      expect.objectContaining({ windowLabel: LABEL, action: "destroy" }),
    );

    fireEvent.click(returnButton());
    await flush(10);
    await emitToWindow(LABEL, "workspace-file-window-return-complete", {
      documentId: "doc-1",
      token: "tok-1",
      windowLabel: LABEL,
    });
    await flush();
    expect(tauriMock.state.windowActions).toContainEqual(
      expect.objectContaining({ windowLabel: LABEL, action: "destroy" }),
    );
  });
});

describe("StandaloneWorkspaceFileWindow listener setup", () => {
  it("reports attach failure to the main window when listener registration fails", async () => {
    tauriMock.failNextListen(
      "workspace-content-window-event",
      new Error("denied"),
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    windowHandle = await mountFileWindow();

    await flush();

    const failed = emittedEnvelopes(
      "workspace-file-window-attach-failed",
    ).filter((event) => event.target === "main");
    expect(failed).toHaveLength(1);
    const inner = (failed[0].payload as { payload: { message?: string } })
      .payload;
    expect(typeof inner.message).toBe("string");
    expect(inner.message).toContain("denied");
    expect(screen.getByText(/denied/)).toBeTruthy();
    // 反向断言：监听都没注册成功，不得发出 ready。
    expect(emittedEnvelopes("workspace-file-window-ready")).toHaveLength(0);
    windowHandle.dispose();
    windowHandle = undefined;
    expect(tauriMock.state.eventListeners).toHaveLength(0);
  });
});

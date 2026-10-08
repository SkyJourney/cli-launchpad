// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 不 mock react-i18next：本文件用真实 i18n 实例切换语言。
vi.mock(
  "sonner",
  async () => (await import("../test/host/hostMocks")).sonnerMock,
);

import { applyRemoteAppLanguage, i18n } from "../i18n";
import { tauriMock } from "../test/tauriMock";
import { resetFakeTerminals } from "../test/host/hostMocks";
import {
  DEFAULT_FILE_WINDOW_LABEL,
  emitToWindow,
  flush,
  mountFileWindow,
} from "../test/host/workspaceHarness";

const LABEL = DEFAULT_FILE_WINDOW_LABEL;
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
beforeEach(async () => {
  await applyRemoteAppLanguage("en");
});
afterEach(async () => {
  windowHandle?.dispose();
  windowHandle = undefined;
  cleanup();
  resetFakeTerminals();
  vi.useRealTimers();
  await flush();
  await applyRemoteAppLanguage("en");
  expect(tauriMock.state.eventListeners).toHaveLength(0);
  expect(tauriMock.state.aclViolations).toEqual([]);
});

function emittedEnvelopes(type: string) {
  return tauriMock.state.emittedEvents.filter(
    (event) => (event.payload as { type?: string }).type === type,
  );
}

describe("StandaloneWorkspaceFileWindow", () => {
  it("does not restart the handoff setup when the UI language changes", async () => {
    windowHandle = await mountFileWindow();
    await flush();
    await emitToWindow(LABEL, "workspace-file-window-init", INIT);
    await flush();
    expect(emittedEnvelopes("workspace-file-window-ready")).toHaveLength(1);
    expect(emittedEnvelopes("workspace-file-window-attached")).toHaveLength(1);

    await act(async () => {
      await applyRemoteAppLanguage("zh");
    });
    await flush();
    expect(i18n.resolvedLanguage).toBe("zh");

    // 语言切换不得重跑交接 setup：就绪事件仍只有最初那一条。
    expect(emittedEnvelopes("workspace-file-window-ready")).toHaveLength(1);

    // 缓冲发布器没有被 dispose：编辑之后照常发布 buffer-changed。
    // flush 依赖真实 setTimeout，所以假计时器只在语言切换和 flush 之后开启。
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.change(screen.getByLabelText("editor"), {
      target: { value: "y" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    const changed = emittedEnvelopes("workspace-file-window-buffer-changed");
    expect(changed.length).toBeGreaterThanOrEqual(1);
    const last = changed[changed.length - 1].payload as {
      payload: { fileBuffer: { content: string } };
    };
    expect(last.payload.fileBuffer.content).toBe("y");

    // 反向断言：语言切换后的重复 init 没有造成错误，窗口内也没有错误提示。
    vi.useRealTimers();
    await emitToWindow(LABEL, "workspace-file-window-init", INIT);
    await flush();
    expect(emittedEnvelopes("workspace-file-window-attach-failed")).toEqual([]);
    expect(document.querySelector(".error")).toBeNull();
    expect(windowHandle.errors).toEqual([]);
  });
});

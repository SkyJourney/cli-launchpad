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
import {
  detachFileToWindow,
  emitToMain,
  flush,
  mountWorkspace,
  openFile,
  type WorkspaceHost,
} from "../test/host/workspaceHarness";

let host: WorkspaceHost | undefined;
afterEach(async () => {
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

describe("exit impacts for detached files", () => {
  it("treats a detached file whose window never acknowledges flush as dirty", async () => {
    host = await mountWorkspace();
    const doc = await openFile(host);
    const { windowLabel } = await detachFileToWindow(host, doc.id);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const pending = host.ctx().collectExitImpacts(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    const result = await pending;

    // 子窗口始终不应答：按“不确定”处理，视为脏。
    expect(result.dirtyFiles).toEqual([
      { documentId: doc.id, relativePath: "a.txt" },
    ]);
    // 反向断言：预检不销毁子窗口。
    expect(tauriMock.state.windowActions).not.toContainEqual(
      expect.objectContaining({ windowLabel, action: "destroy" }),
    );
    expect(host.errors).toEqual([]);
  });

  it("uses the window's flushed buffer when it acknowledges in time", async () => {
    host = await mountWorkspace();
    const doc = await openFile(host);
    const { token, windowLabel, initBuffer } = await detachFileToWindow(
      host,
      doc.id,
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    let resolved = false;
    const pending = host
      .ctx()
      .collectExitImpacts(0)
      .then((value) => {
        resolved = true;
        return value;
      });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const request = tauriMock.state.emittedEvents.find(
      (event) =>
        event.target === windowLabel &&
        (event.payload as { type?: string }).type ===
          "workspace-file-window-flush-requested",
    );
    expect(request).toBeDefined();
    const requestId = (request!.payload as { payload: { requestId: string } })
      .payload.requestId;
    await emitToMain("workspace-file-window-flush-complete", {
      documentId: doc.id,
      token,
      windowLabel,
      requestId,
      fileDocument: doc,
      fileBuffer: {
        ...initBuffer,
        content: "x",
        version: initBuffer.version + 1,
      },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    // 反向断言：只推进了 10 ms 虚拟时间就已 resolve，没有等满 500 ms 超时。
    expect(resolved).toBe(true);
    const result = await pending;

    expect(result.dirtyFiles).toHaveLength(1);
    expect(host.ctx().fileBuffers[doc.id].content).toBe("x");
    expect(host.errors).toEqual([]);
  });
});

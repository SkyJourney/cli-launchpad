// @vitest-environment jsdom
import { act, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 不 mock react-i18next：本文件用真实 i18n 实例切换语言，才能复现 t 身份变化。
vi.mock(
  "sonner",
  async () => (await import("../test/host/hostMocks")).sonnerMock,
);
vi.mock(
  "./PtyTerminal",
  async () => (await import("../test/host/hostMocks")).ptyTerminalMock,
);

import { i18n } from "../i18n";
import { tauriMock } from "../test/tauriMock";
import { fakeTerminals, resetFakeTerminals } from "../test/host/hostMocks";
import { assertWorkspaceInvariants } from "../test/host/workspaceInvariants";
import {
  detachFileToWindow,
  flush,
  invokes,
  launchPty,
  mountWorkspace,
  openFile,
  type WorkspaceHost,
} from "../test/host/workspaceHarness";
import { listWorkspacePanes } from "../lib/ptyWorkspaceLayout";
import { WorkspaceContentCoordinator } from "../lib/workspaceContentCoordinator";
import type { WorkspaceSlotState } from "../lib/tauri";

let host: WorkspaceHost | undefined;
let loadingObserver: MutationObserver | undefined;
beforeEach(async () => {
  await i18n.changeLanguage("en");
});
afterEach(async () => {
  loadingObserver?.disconnect();
  loadingObserver = undefined;
  host?.dispose();
  host = undefined;
  cleanup();
  resetFakeTerminals();
  vi.useRealTimers();
  await flush();
  await i18n.changeLanguage("en");
  expect(tauriMock.state.eventListeners).toHaveLength(0);
  expect(tauriMock.state.aclViolations).toEqual([]);
});

/** 记录“工作区加载中”占位是否曾经出现；rehydrate 会让它短暂出现，所以只看 DOM 变更记录。 */
function watchForLoadingPlaceholder() {
  let seen = 0;
  const inspect = (records: MutationRecord[]) => {
    for (const record of records) {
      record.addedNodes.forEach((node) => {
        if (
          node instanceof Element &&
          (node.matches(".pty-workspace-loading") ||
            node.querySelector(".pty-workspace-loading"))
        ) {
          seen += 1;
        }
      });
    }
  };
  loadingObserver = new MutationObserver(inspect);
  loadingObserver.observe(document.body, { childList: true, subtree: true });
  return {
    count() {
      inspect(loadingObserver!.takeRecords());
      return seen;
    },
  };
}

function backendReadyFromLastSave(
  target: WorkspaceHost,
  slotStates: WorkspaceSlotState[],
) {
  const last = target.backend.saved[target.backend.saved.length - 1];
  expect(last).toBeDefined();
  target.backend.layout = {
    status: { status: "ready" },
    revision: last.revision,
    layout: last.layout,
    slotStates,
    schemaVersion: 5,
    updatedAtMs: null,
  };
}

describe("workspace across UI language changes", () => {
  it("does not rehydrate, drop buffers or remove running PTYs when the language changes", async () => {
    host = await mountWorkspace();
    const doc = await openFile(host);
    const { slot } = await launchPty(host);
    await act(async () => {
      host!.ctx().editFile(doc.id, "unsaved edit");
    });
    await flush(10);
    backendReadyFromLastSave(host, [
      {
        instanceId: slot.instanceId,
        state: "running",
        currentProjectName: "Project",
      },
    ]);
    const loading = watchForLoadingPlaceholder();
    const savedBefore = host.backend.saved.length;
    expect(invokes("get_workspace_layout")).toHaveLength(1);

    await act(async () => {
      await i18n.changeLanguage("zh");
    });
    await flush(10);

    expect(i18n.resolvedLanguage).toBe("zh");
    expect(invokes("get_workspace_layout")).toHaveLength(1);
    expect(host.ctx().fileBuffers[doc.id].content).toBe("unsaved edit");
    expect(host.ctx().slots.map((item) => item.instanceId)).toEqual([
      slot.instanceId,
    ]);
    expect(fakeTerminals).toHaveLength(1);
    expect(fakeTerminals[0].startSession).toHaveBeenCalledTimes(1);
    // 语言切换不触发保存（门禁 E-05）。
    expect(host.backend.saved).toHaveLength(savedBefore);
    expect(() => assertWorkspaceInvariants(host!)).not.toThrow();
    // 反向断言：切换语言期间工作区从未回到“加载中”，也没有渲染期错误。
    expect(loading.count()).toBe(0);
    expect(host.ctx().hydrationStatus).toBe("ready");
    expect(host.errors).toEqual([]);
  });

  it("keeps a detached file owned by its window and flush-protected after a language change", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    const doc = await openFile(host);
    const { windowLabel } = await detachFileToWindow(host, doc.id);
    await flush(10);
    backendReadyFromLastSave(host, []);

    // 步骤 1：切换语言。
    await act(async () => {
      await i18n.changeLanguage("zh");
    });
    await flush(10);
    expect(i18n.resolvedLanguage).toBe("zh");
    expect(invokes("get_workspace_layout")).toHaveLength(1);
    expect(host.ctx().detachedFileIds.has(doc.id)).toBe(true);
    expect(
      listWorkspacePanes(host.ctx().tree).some((pane) =>
        pane.contents.some(
          (item) => item.kind === "file" && item.documentId === doc.id,
        ),
      ),
    ).toBe(false);

    // 步骤 2~4：退出预检向仍占有该文件的窗口请求 flush；子窗口没有应答，按不确定处理。
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const impacts = host.ctx().collectExitImpacts(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    const result = await impacts;

    expect(result.dirtyFiles.map((file) => file.documentId)).toEqual([doc.id]);
    const flushRequests = tauriMock.state.emittedEvents.filter(
      (event) =>
        event.target === windowLabel &&
        (event.payload as { type?: string }).type ===
          "workspace-file-window-flush-requested",
    );
    expect(flushRequests.length).toBeGreaterThanOrEqual(1);
    // 反向断言：语言切换没有销毁子窗口，也没有撤销它的文件授权。
    expect(tauriMock.state.windowActions).not.toContainEqual(
      expect.objectContaining({ windowLabel, action: "destroy" }),
    );
    expect(invokes("revoke_content_window_file")).toHaveLength(0);
    expect(host.errors).toEqual([]);
  });
});

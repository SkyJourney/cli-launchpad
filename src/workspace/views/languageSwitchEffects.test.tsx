// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerBuiltinContributions } from "../../bootstrap/registerBuiltinContributions";
import { applyRemoteAppLanguage, setAppLanguage } from "../../i18n";
import type { WorkspaceFileDocument } from "../../lib/tauri";
import { tauriMock } from "../../test/tauriMock";
import { FakeResizeObserver } from "../../test/host/domPolyfills";
import { toastSpy } from "../../test/host/hostMocks";
import { WorkspaceLayoutManager } from "./WorkspaceLayoutManager";
import { WorkspacePaneView } from "./WorkspacePaneView";

vi.mock(
  "sonner",
  async () => (await import("../../test/host/hostMocks")).sonnerMock,
);

// R-FE-1（m6-b24-cleanup-C2）：语言切换既不能让业务 effect 重新执行，
// 也不能让异步回调里还停留在切换前的翻译函数。
beforeEach(async () => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  await applyRemoteAppLanguage("en");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const FILE: WorkspaceFileDocument = {
  id: "doc-1",
  directoryId: 1,
  directoryPath: "/project",
  relativePath: "a.txt",
};

function paneViewProps(): ComponentProps<typeof WorkspacePaneView> {
  const content = { kind: "file", documentId: FILE.id } as const;
  return {
    node: { kind: "pane", id: "pane-1", paneNumber: 1, contents: [content] },
    pane: {
      kind: "pane",
      id: "pane-1",
      paneNumber: 1,
      contents: [content],
      activeContent: content,
    },
    slots: [],
    fileDocuments: [FILE],
    fileBuffers: {},
    isHandoffContent: () => false,
    isDetachedContent: () => false,
    closingContentKeys: new Set(),
    focusedPaneId: "pane-1",
    portalTargets: {},
    canCloseEmptyPane: false,
    selectedDirectoryId: 1,
    directories: [{ id: 1, name: "project" }],
    ptySessionsById: {},
    workspacePanes: [],
    onFocusPane: vi.fn(),
    onActivateContent: vi.fn(),
    onSplitAndMoveContent: vi.fn(),
    onMoveContent: vi.fn(),
    onCloseContents: vi.fn(async () => undefined),
    onDetachFile: vi.fn(),
    onEditFile: vi.fn(),
    onSaveFile: vi.fn(async () => undefined),
    onSplitPane: vi.fn(),
    hasDetachedSessions: false,
    isManagedDetachedContent: vi.fn(() => false),
    onDetachSession: vi.fn(),
    onCloseEmptyPane: vi.fn(),
    onSplitResize: vi.fn(),
  };
}

describe("language switch and business effects", () => {
  // m6-115：视图不再自行加载文件；加载失败的提示语言由宿主的显式加载器（activeFileLoader）决定。
  it("the pane view never loads a file by itself, so a language change cannot trigger a load", async () => {
    const unregister = registerBuiltinContributions();
    try {
      render(<WorkspacePaneView {...paneViewProps()} />);
      await act(async () => {
        await setAppLanguage("zh");
      });
      expect(toastSpy.error).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it("does not reload layout presets when the language changes while the panel is open", async () => {
    tauriMock.setInvokeHandler((command) =>
      command === "list_workspace_layout_presets" ? [] : undefined,
    );
    render(
      <WorkspaceLayoutManager
        getCurrentLayout={() => {
          throw new Error("the current layout is not needed to list presets");
        }}
        onApply={vi.fn(async () => undefined)}
      />,
    );
    const listCalls = () =>
      tauriMock.state.invokeCalls.filter(
        (call) => call.command === "list_workspace_layout_presets",
      );

    fireEvent.click(screen.getByRole("button", { expanded: false }));
    await vi.waitFor(() => expect(listCalls()).toHaveLength(1));

    await setAppLanguage("zh");
    await act(async () => {
      await Promise.resolve();
    });

    expect(listCalls()).toHaveLength(1);
  });
});

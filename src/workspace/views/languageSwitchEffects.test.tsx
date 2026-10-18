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

function paneViewProps(
  onLoadFile: (documentId: string) => Promise<void>,
): ComponentProps<typeof WorkspacePaneView> {
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
    handoffFileIds: new Set(),
    detachedFileIds: new Set(),
    closingContentKeys: new Set(),
    focusedPaneId: "pane-1",
    portalTargets: {},
    canCloseEmptyPane: false,
    selectedDirectoryId: 1,
    directories: [{ id: 1, name: "project" }],
    ptySessionsById: {},
    workspacePanes: [],
    onFocusPane: vi.fn(),
    onActivateSession: vi.fn(),
    onActivateFile: vi.fn(),
    onActivateUnsupportedContent: vi.fn(),
    onCloseContents: vi.fn(async () => undefined),
    onDetachFile: vi.fn(),
    onMoveFile: vi.fn(),
    onEditFile: vi.fn(),
    onLoadFile,
    onSaveFile: vi.fn(async () => undefined),
    onSplitPane: vi.fn(),
    onSplitAndMoveSession: vi.fn(),
    onSplitAndMoveFile: vi.fn(),
    onMoveSession: vi.fn(),
    hasDetachedSessions: false,
    isManagedDetachedDrag: vi.fn(() => false),
    isManagedDetachedFileDrag: vi.fn(() => false),
    onDetachSession: vi.fn(),
    onCloseEmptyPane: vi.fn(),
    onSplitResize: vi.fn(),
  };
}

describe("language switch and business effects", () => {
  it("reports a file load failure in the language active when it fails", async () => {
    const unregister = registerBuiltinContributions();
    try {
      let reject: (reason: unknown) => void = () => undefined;
      const onLoadFile = vi.fn(
        () =>
          new Promise<void>((_, rejectLoad) => {
            reject = rejectLoad;
          }),
      );
      render(<WorkspacePaneView {...paneViewProps(onLoadFile)} />);
      expect(onLoadFile).toHaveBeenCalledTimes(1);

      await setAppLanguage("zh");
      expect(onLoadFile).toHaveBeenCalledTimes(1);
      await act(async () => {
        reject({ code: "project.not_found", message: "missing" });
      });

      await vi.waitFor(() => expect(toastSpy.error).toHaveBeenCalled());
      expect(toastSpy.error.mock.calls[0][0]).toBe("找不到该项目目录。");
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

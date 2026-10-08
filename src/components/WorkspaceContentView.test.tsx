// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspacePaneContentRef } from "../lib/tauri";
import { WorkspaceContentView } from "./WorkspaceContentView";
import { registerWorkspaceContentAdapter } from "./workspaceContentAdapterRegistry";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { kind?: string; error?: string }) => {
      if (options?.kind) return `${key}:${options.kind}`;
      if (options?.error) return `${key}:${options.error}`;
      return key;
    },
  }),
}));

const labels = {
  menu: "menu",
  close: "close",
  closeCurrent: "closeCurrent",
  closeOthers: "closeOthers",
  closeAll: "closeAll",
  splitAndMoveRight: "splitRight",
  splitAndMoveDown: "splitDown",
};

const unregisterAdapters: Array<() => void> = [];

afterEach(() => {
  cleanup();
  unregisterAdapters.splice(0).forEach((unregister) => unregister());
});

function renderContent(
  content: WorkspacePaneContentRef,
  onCloseUnsupported = vi.fn(),
) {
  return {
    onCloseUnsupported,
    ...render(
      <WorkspaceContentView
        content={content}
        fileDocument={undefined}
        fileBuffer={undefined}
        onEditFile={vi.fn()}
        onSaveFile={vi.fn(async () => undefined)}
        onCloseUnsupported={onCloseUnsupported}
      />,
    ),
  };
}

describe("WorkspaceContentView", () => {
  it("shows and closes a placeholder for an unknown persisted content kind", () => {
    const onClose = vi.fn();
    renderContent(
      {
        kind: "unknown",
        originalKind: "markdownPreview",
        raw: { kind: "markdownPreview", source: "README.md" },
      },
      onClose,
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "workspaceContent.unsupportedTitle:markdownPreview",
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows a placeholder when a known content kind has no registered adapter", () => {
    renderContent({ kind: "file", documentId: "file-1" });

    expect(screen.getByRole("alert").textContent).toContain(
      "workspaceContent.unsupportedTitle:file",
    );
  });

  it("contains render failures from registered adapters", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    unregisterAdapters.push(
      registerWorkspaceContentAdapter({
        id: "test.throwing-content",
        apiVersion: 2,
        kind: "pty",
        render: () => {
          throw new Error("adapter render failed");
        },
        presentation: () => ({
          title: "Terminal",
          icon: null,
          closeLabelKey: "close",
        }),
        labels,
        projectContextOf: () => null,
      }),
    );

    try {
      renderContent({ kind: "pty", slotId: "terminal-1" });
      expect(screen.getByRole("alert").textContent).toContain(
        "workspaceContent.unsupportedTitle:pty",
      );
      expect(screen.getByRole("alert").textContent).toContain(
        "workspaceContent.unsupportedError:adapter render failed",
      );
      expect(screen.getByRole("button").textContent).toBe(
        "workspaceContent.closeUnsupported",
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it.each([undefined, null])(
    "shows the localized generic description when an adapter throws %s",
    (thrown) => {
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      unregisterAdapters.push(
        registerWorkspaceContentAdapter({
          id: "test.throwing-nullish-content",
          apiVersion: 2,
          kind: "pty",
          render: () => {
            throw thrown;
          },
          presentation: () => ({
            title: "Terminal",
            icon: null,
            closeLabelKey: "close",
          }),
          labels,
          projectContextOf: () => null,
        }),
      );

      try {
        renderContent({ kind: "pty", slotId: "terminal-1" });
        const alert = screen.getByRole("alert").textContent ?? "";
        expect(alert).toContain("workspaceContent.unsupportedDescription");
        // 反向断言：不得把写死的英文兜底文案带进界面。
        expect(alert).not.toContain("Unknown error");
        expect(alert).not.toContain("workspaceContent.unsupportedError");
      } finally {
        consoleError.mockRestore();
      }
    },
  );
});

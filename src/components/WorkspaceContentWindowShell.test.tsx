// @vitest-environment jsdom
import "../test/tauriMock";
import {
  createEvent,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { tauriMock } from "../test/tauriMock";
import { WorkspaceContentWindowShell } from "./WorkspaceContentWindowShell";

describe("WorkspaceContentWindowShell", () => {
  it("routes a pre-ready close to the attach rollback policy", async () => {
    const label = "workspace-content-8e783338-f464-4b10-b15e-b534748c6241";
    tauriMock.setCurrentWindowLabel(label);
    const onCloseBeforeReady = vi.fn();
    const onCloseRequested = vi.fn();

    render(
      <WorkspaceContentWindowShell
        title="Notes"
        actions={null}
        isReady={false}
        onCloseBeforeReady={onCloseBeforeReady}
        onCloseRequested={onCloseRequested}
      >
        <div>Content</div>
      </WorkspaceContentWindowShell>,
    );

    await waitFor(() =>
      expect(
        tauriMock.getWindow(label).onCloseRequested,
      ).toHaveBeenCalledOnce(),
    );
    tauriMock.emitEvent("tauri://close-requested", {}, label);

    expect(onCloseBeforeReady).toHaveBeenCalledOnce();
    expect(onCloseRequested).not.toHaveBeenCalled();
  });

  it("owns notifications and prevents the browser context menu", async () => {
    tauriMock.setCurrentWindowLabel(
      "workspace-content-8e783338-f464-4b10-b15e-b534748c6241",
    );
    const { container } = render(
      <WorkspaceContentWindowShell
        title="Notes"
        actions={null}
        onCloseRequested={vi.fn()}
      >
        <div>Content</div>
      </WorkspaceContentWindowShell>,
    );

    await waitFor(() =>
      expect(
        document.querySelector('[aria-label^="Notifications"]'),
      ).not.toBeNull(),
    );
    const contextMenu = createEvent.contextMenu(
      container.querySelector("main")!,
    );
    fireEvent(container.querySelector("main")!, contextMenu);
    expect(contextMenu.defaultPrevented).toBe(true);
  });
});

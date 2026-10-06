// @vitest-environment jsdom
import "../test/tauriMock";
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { tauriMock } from "../test/tauriMock";
import { WorkspaceContentWindowShell } from "./WorkspaceContentWindowShell";

describe("WorkspaceContentWindowShell", () => {
  it("routes a pre-ready close to the attach rollback policy", async () => {
    const label = "workspace-content-test";
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
});

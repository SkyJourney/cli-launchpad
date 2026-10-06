// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { listen } from "@tauri-apps/api/event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tauriMock } from "../test/tauriMock";

const { rehydrateWorkspace } = vi.hoisted(() => ({
  rehydrateWorkspace: vi.fn(async () => undefined),
}));

vi.mock("./PtyWorkspace", () => ({
  usePtyWorkspace: () => ({ rehydrateWorkspace }),
}));

import { WorkspaceDataRestoreListener } from "./WorkspaceDataRestoreListener";

afterEach(() => {
  cleanup();
  tauriMock.reset();
  vi.clearAllMocks();
});

describe("WorkspaceDataRestoreListener", () => {
  it("rehydrates the workspace after the backend reports a completed restore", async () => {
    render(<WorkspaceDataRestoreListener />);
    await waitFor(() => {
      expect(listen).toHaveBeenCalledWith(
        "workspace-data-restored",
        expect.any(Function),
      );
    });

    tauriMock.emitEvent("workspace-data-restored", {}, "main");

    await waitFor(() => expect(rehydrateWorkspace).toHaveBeenCalledTimes(1));
  });
});

// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
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
      expect(
        tauriMock.state.invokeCalls.filter(
          (call) => call.command === "subscribe_window_inbox",
        ),
      ).toHaveLength(1);
    });

    tauriMock.deliverInbox("main", "workspace-data-restored", {});

    await waitFor(() => expect(rehydrateWorkspace).toHaveBeenCalledTimes(1));
  });
});

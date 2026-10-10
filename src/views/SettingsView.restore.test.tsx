// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "react-i18next",
  async () => (await import("../test/host/hostMocks")).reactI18nextMock,
);
vi.mock(
  "sonner",
  async () => (await import("../test/host/hostMocks")).sonnerMock,
);

const workspace = vi.hoisted(() => ({
  getBackupRestoreBlockers: vi.fn(async () => ({
    runningPtyCount: 0,
    dirtyFileCount: 0,
    detachedWindowCount: 0,
  })),
  cancelBackupRestore: vi.fn(),
  resumeAfterFailedRestore: vi.fn(),
  rehydrateWorkspace: vi.fn(async () => undefined),
}));
vi.mock("../components/PtyWorkspace", () => ({
  usePtyWorkspace: () => workspace,
}));

import type { BackupManifest } from "../lib/tauri";
import { tauriMock } from "../test/tauriMock";
import { SettingsView } from "./SettingsView";

const BACKUP: BackupManifest = {
  id: "b1",
  createdAtMs: 1,
  reason: "manual",
  schemaVersion: 1,
  databaseFilename: "b1.db",
  sizeBytes: 1024,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  expect(tauriMock.state.eventListeners).toHaveLength(0);
});

describe("SettingsView backup restore wiring", () => {
  it("resumes persisting without reloading the workspace when the restore is rejected", async () => {
    tauriMock.setInvokeHandler((command) => {
      if (command === "list_backups") return [BACKUP];
      if (command === "restore_backup") {
        throw { code: "backup.restore_rejected", message: "恢复被拒绝" };
      }
      return undefined;
    });
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <SettingsView />
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByText("settings.restore"));
    fireEvent.click(await screen.findByText("settings.confirmRestoreAction"));

    await waitFor(() =>
      expect(workspace.resumeAfterFailedRestore).toHaveBeenCalledTimes(1),
    );
    expect(workspace.cancelBackupRestore).not.toHaveBeenCalled();
  });
});

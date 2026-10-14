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
  createBackend,
  DIRECTORY,
  flush,
  invokes,
  launchPty,
  mountWorkspace,
  openFile,
  type WorkspaceHost,
} from "../test/host/workspaceHarness";
import { listWorkspacePanes } from "../lib/ptyWorkspaceLayout";
import { qk } from "../lib/queryKeys";

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

const panes = () => listWorkspacePanes(host!.ctx().tree);

describe("layout persistence", () => {
  it("saves the layout after a file is opened and keeps revisions increasing", async () => {
    host = await mountWorkspace();
    const before = host.backend.saved.length;

    await openFile(host);
    await flush();

    expect(host.backend.saved.length).toBeGreaterThan(before);
    expect(
      host.backend.saved[host.backend.saved.length - 1].layout.documents.map(
        (d) => d.relativePath,
      ),
    ).toContain("a.txt");
    const revisions = host.backend.saved.map((s) => s.revision);
    expect(revisions.every((r, i) => i === 0 || r > revisions[i - 1])).toBe(
      true,
    );
    expect(host.errors).toEqual([]);
    expect(host.ctx().layoutSaveError).toBeNull();
  });

  it("does not save before the workspace is ready and starts saving after resetWorkspace", async () => {
    const backend = createBackend({
      status: { status: "needsReset", reason: "bad" },
    });
    backend.handlers.set("reset_workspace_layout", () => 4);
    host = await mountWorkspace({ backend });

    expect(host.ctx().hydrationStatus).toBe("needsReset");
    expect(host.ctx().hydrationError).toBe("bad");

    act(() => host!.ctx().splitPane(panes()[0].id, "horizontal"));
    expect(host.backend.saved.length).toBe(0);
    expect(invokes("save_workspace_layout")).toHaveLength(0);

    await act(async () => {
      await host!.ctx().resetWorkspace();
    });
    expect(host.ctx().hydrationStatus).toBe("ready");
    expect(host.ctx().hydrationError).toBeNull();
    expect(invokes("reset_workspace_layout")).toHaveLength(1);

    act(() => host!.ctx().splitPane(panes()[0].id, "vertical"));
    await flush();
    expect(host.backend.saved[0].revision).toBe(5);
  });

  it("retryHydration loads the layout again after a load failure", async () => {
    const backend = createBackend();
    let calls = 0;
    backend.handlers.set("get_workspace_layout", () => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return backend.layout;
    });
    host = await mountWorkspace({ backend });

    expect(host.ctx().hydrationStatus).toBe("loadFailed");
    expect(host.ctx().hydrationError).toContain("boom");

    await act(async () => {
      host!.ctx().retryHydration();
    });
    await flush();
    expect(host.ctx().hydrationStatus).toBe("ready");
    expect(host.ctx().hydrationError).toBeNull();
    expect(calls).toBe(2);
    expect(host.errors).toEqual([]);
  });

  it("hydrates exactly once while unrelated state changes", async () => {
    host = await mountWorkspace();
    const count = () => invokes("get_workspace_layout").length;
    expect(count()).toBe(1);

    await openFile(host);
    await launchPty(host);
    act(() => host!.ctx().focusPane(panes()[0].id));
    await act(async () => {
      host!.queryClient.setQueryData(qk.directories(), [
        { ...DIRECTORY, name: "Renamed project" },
      ]);
    });
    await flush();

    expect(count()).toBe(1);
    expect(host.ctx().hydrationStatus).toBe("ready");
    expect(host.errors).toEqual([]);
  });

  it("a sash drag publishes the layout on drag end and not while dragging", async () => {
    host = await mountWorkspace();
    act(() => host!.ctx().splitPane(panes()[0].id, "horizontal"));
    await flush();
    const splitId = (host.ctx().tree as { id: string }).id;
    const before = host.backend.saved.length;

    act(() => host!.ctx().updateSplitRatio(splitId, [30, 70], "change"));
    expect(host.backend.saved.length).toBe(before);

    act(() => host!.ctx().updateSplitRatio(splitId, [30, 70], "dragEnd"));
    await flush();
    expect(host.backend.saved.length).toBe(before + 1);
    expect((host.ctx().tree as { ratio: number }).ratio).toBeCloseTo(0.3, 5);
    expect(host.errors).toEqual([]);
  });

  it("a directories query refresh does not save the layout", async () => {
    host = await mountWorkspace();
    await openFile(host);
    await flush();
    const before = host.backend.saved.length;

    await act(async () => {
      host!.queryClient.setQueryData(qk.directories(), [
        { ...DIRECTORY, name: "Renamed project" },
      ]);
    });
    await flush();

    expect(host.backend.saved.length).toBe(before);
    expect(host.ctx().fileDocuments.map((d) => d.relativePath)).toContain(
      "a.txt",
    );
    expect(invokes("get_workspace_layout")).toHaveLength(1);
  });
});

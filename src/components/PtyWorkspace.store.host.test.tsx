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
import { assertWorkspaceInvariants } from "../test/host/workspaceInvariants";
import {
  createBackend,
  flush,
  launchPty,
  mountWorkspace,
  openFile,
  type WorkspaceHost,
} from "../test/host/workspaceHarness";
import { listWorkspacePanes } from "../lib/ptyWorkspaceLayout";

let host: WorkspaceHost | undefined;
afterEach(async () => {
  host?.dispose();
  host = undefined;
  cleanup();
  resetFakeTerminals();
  vi.useRealTimers();
  await flush();
  expect(tauriMock.state.eventListeners).toHaveLength(0);
  expect(tauriMock.state.aclViolations).toEqual([]);
});

describe("workspace host state ownership", () => {
  it("keeps the live split ratio readable while the published tree changes only at drag end", async () => {
    const backend = createBackend({
      status: { status: "ready" },
      revision: 1,
      slotStates: [],
      schemaVersion: 5,
      updatedAtMs: null,
      layout: {
        schemaVersion: 5,
        focusedPaneId: "pa",
        slots: [],
        documents: [],
        detachedContents: [],
        tree: {
          kind: "split",
          id: "s1",
          direction: "horizontal",
          ratio: 0.5,
          first: {
            kind: "pane",
            id: "pa",
            paneNumber: 1,
            contents: [],
            activeContent: null,
          },
          second: {
            kind: "pane",
            id: "pb",
            paneNumber: 2,
            contents: [],
            activeContent: null,
          },
        },
      },
    } as never);
    host = await mountWorkspace({ backend });
    await flush();

    const before = host.ctx().tree;
    expect(before.kind).toBe("split");
    if (before.kind !== "split") throw new Error("expected a split tree");
    expect(before.ratio).toBe(0.5);

    // 拖拽中：实时读取到新比例，但发布的树对象不变，也不触发发布。
    await act(async () => {
      host!.ctx().updateSplitRatio("s1", [30, 70], "change");
    });
    expect(host.ctx().tree).toBe(before);
    const live = host.ctx().getCurrentPresetLayout().tree;
    expect(live.kind).toBe("split");
    if (live.kind !== "split") throw new Error("expected a live split tree");
    expect(live.ratio).toBeCloseTo(0.3);

    // 拖拽结束：发布新树。
    await act(async () => {
      host!.ctx().updateSplitRatio("s1", [30, 70], "dragEnd");
    });
    await flush();
    expect(host.ctx().tree).not.toBe(before);
    const published = host.ctx().tree;
    expect(published.kind).toBe("split");
    if (published.kind !== "split") throw new Error("expected a split tree");
    expect(published.ratio).toBeCloseTo(0.3);
    expect(assertWorkspaceInvariants(host)).toEqual({ skipped: ["I4", "I7"] });
    expect(host.errors).toEqual([]);
  });

  it("rehydrate resets documents, buffers, slots and tree together", async () => {
    host = await mountWorkspace();
    const doc = await openFile(host);
    await launchPty(host);
    const before = host.ctx().workspaceTreeRevision;

    await act(async () => {
      await host!.ctx().rehydrateWorkspace();
    });
    await flush();

    expect(host.ctx().fileDocuments).toEqual([]);
    expect(host.ctx().fileBuffers).toEqual({});
    expect(host.ctx().slots).toEqual([]);
    expect(listWorkspacePanes(host.ctx().tree)).toHaveLength(1);
    expect(listWorkspacePanes(host.ctx().tree)[0]?.contents).toEqual([]);
    expect(host.ctx().workspaceTreeRevision).toBeGreaterThan(before);
    expect(host.ctx().hydrationStatus).toBe("ready");
    expect(assertWorkspaceInvariants(host)).toEqual({ skipped: ["I4", "I7"] });
    expect(host.ctx().fileDocuments.map((d) => d.id)).not.toContain(doc.id);
    expect(host.errors).toEqual([]);
  });
});

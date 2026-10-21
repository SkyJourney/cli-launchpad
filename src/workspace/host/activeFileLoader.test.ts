import { describe, expect, it, vi } from "vitest";
import {
  addWorkspaceFileToPane,
  createWorkspacePane,
  splitWorkspacePane,
} from "../../lib/ptyWorkspaceLayout";
import { createActiveFileLoader, activeFileIdsOf } from "./activeFileLoader";
import {
  createInitialHostSnapshot,
  type HostSnapshot,
} from "./workspaceHostStore";

/** 两个窗格：pa 的活动文件为 d1，pb 的活动文件为 d2；两个都还没有 buffer。 */
function twoPaneSnapshot(buffers: Record<string, unknown> = {}): HostSnapshot {
  let tree = splitWorkspacePane(
    createWorkspacePane("pa"),
    "pa",
    "horizontal",
    "sp",
    "pb",
  );
  tree = addWorkspaceFileToPane(tree, "pa", "d1");
  tree = addWorkspaceFileToPane(tree, "pb", "d2");
  return {
    ...createInitialHostSnapshot("pa"),
    tree,
    buffers: buffers as HostSnapshot["buffers"],
  };
}

function harness(initial: HostSnapshot) {
  let snapshot = initial;
  const load = vi.fn(async (documentId: string) => {
    snapshot = {
      ...snapshot,
      buffers: { ...snapshot.buffers, [documentId]: { content: "x" } as never },
    };
  });
  const onError = vi.fn();
  const loader = createActiveFileLoader({
    getSnapshot: () => snapshot,
    load,
    onError,
  });
  return {
    loader,
    load,
    onError,
    setSnapshot: (next: HostSnapshot) => {
      snapshot = next;
    },
  };
}

describe("activeFileLoader", () => {
  it("AL-1 loads the active file of every pane that has no buffer, once per file", async () => {
    const h = harness(twoPaneSnapshot());
    h.loader.ensure();
    h.loader.ensure();
    await vi.waitFor(() => expect(h.load).toHaveBeenCalledTimes(2));
    expect(h.load.mock.calls.map(([id]) => id).sort()).toEqual(["d1", "d2"]);
  });

  it("AL-2 does nothing when the active files already have buffers", () => {
    const h = harness(
      twoPaneSnapshot({ d1: { content: "a" }, d2: { content: "b" } }),
    );
    h.loader.ensure();
    expect(h.load).not.toHaveBeenCalled();
  });

  it("AL-3 does not retry a failed file until it stops being an active file", async () => {
    const h = harness(twoPaneSnapshot());
    h.load.mockImplementation(async (documentId: string) => {
      if (documentId === "d1") throw new Error("boom");
    });
    h.loader.ensure();
    await vi.waitFor(() => expect(h.onError).toHaveBeenCalledTimes(1));

    h.loader.ensure();
    expect(h.load.mock.calls.filter(([id]) => id === "d1")).toHaveLength(1);

    // d1 leaves the layout: its failure record is dropped, so it can be retried when active again.
    const withoutD1 = {
      ...twoPaneSnapshot(),
      tree: addWorkspaceFileToPane(createWorkspacePane("pa"), "pa", "d2"),
    };
    h.setSnapshot(withoutD1);
    h.loader.ensure();
    h.setSnapshot(twoPaneSnapshot());
    h.loader.ensure();
    await vi.waitFor(() =>
      expect(h.load.mock.calls.filter(([id]) => id === "d1")).toHaveLength(2),
    );
  });

  it("AL-4 reset clears failure records so a replaced layout can retry the same file", async () => {
    const h = harness(twoPaneSnapshot());
    h.load.mockRejectedValueOnce(new Error("boom"));
    h.loader.ensure();
    await vi.waitFor(() => expect(h.onError).toHaveBeenCalledTimes(1));
    h.loader.reset();
    h.loader.ensure();
    await vi.waitFor(() =>
      expect(h.load.mock.calls.filter(([id]) => id === "d1")).toHaveLength(2),
    );
  });

  it("lists only file contents of the panes' active tabs", () => {
    expect(activeFileIdsOf(twoPaneSnapshot()).sort()).toEqual(["d1", "d2"]);
  });
});

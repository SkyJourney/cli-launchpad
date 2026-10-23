import { describe, expect, it, vi } from "vitest";
import { createWorkspacePane } from "../../lib/ptyWorkspaceLayout";
import {
  createInitialHostSnapshot,
  WorkspaceHostStore,
  type HostSnapshot,
} from "./workspaceHostStore";

function snap(overrides: Partial<HostSnapshot> = {}): HostSnapshot {
  return { ...createInitialHostSnapshot("p1"), ...overrides };
}

describe("WorkspaceHostStore", () => {
  it("returns the initial snapshot by identity until a commit changes it", () => {
    const initial = snap();
    const store = new WorkspaceHostStore(initial);

    expect(store.getSnapshot()).toBe(initial);
    expect(store.getLive()).toBe(initial);
    expect(store.commitCount).toBe(0);
    expect(store.lastReason).toBeNull();
    expect(store.getSnapshot()).toBe(store.getSnapshot());
  });

  it("commit replaces the snapshot and notifies every subscriber once", () => {
    const initial = snap();
    const store = new WorkspaceHostStore(initial);
    const a = vi.fn();
    const b = vi.fn();
    store.subscribe(a);
    store.subscribe(b);

    const next = store.commit(
      (live) => ({ ...live, focusedPaneId: "p2" }),
      "test:focus",
    );

    expect(next.focusedPaneId).toBe("p2");
    expect(store.getSnapshot()).toBe(next);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(store.commitCount).toBe(1);
    expect(store.lastReason).toBe("test:focus");
    expect(initial.focusedPaneId).toBe("p1");
  });

  it("commit returning the same object does not notify", () => {
    const initial = snap();
    const store = new WorkspaceHostStore(initial);
    const listener = vi.fn();
    store.subscribe(listener);

    expect(store.commit((live) => live, "noop")).toBe(initial);
    expect(listener).not.toHaveBeenCalled();
    expect(store.commitCount).toBe(0);
    expect(store.lastReason).toBeNull();
  });

  it("commit returning a field-wise equal snapshot keeps the previous identity and does not notify", () => {
    const initial = snap();
    const store = new WorkspaceHostStore(initial);
    const listener = vi.fn();
    store.subscribe(listener);

    const result = store.commit((live) => ({ ...live }), "clone");

    expect(result).toBe(initial);
    expect(store.getSnapshot()).toBe(initial);
    expect(listener).not.toHaveBeenCalled();
    expect(store.commitCount).toBe(0);

    // 反向：新数组不是同一引用，必须通知。
    store.commit((live) => ({ ...live, slots: [...live.slots] }), "new-array");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe stops notifications and is idempotent", () => {
    const store = new WorkspaceHostStore(snap());
    const listener = vi.fn();
    const stop = store.subscribe(listener);

    stop();
    store.commit((l) => ({ ...l, treeRevision: l.treeRevision + 1 }), "r");
    expect(listener).not.toHaveBeenCalled();
    expect(() => stop()).not.toThrow();
  });

  it("a throwing listener does not prevent later listeners from being notified", () => {
    const store = new WorkspaceHostStore(snap());
    const bad = vi.fn(() => {
      throw new Error("listener boom");
    });
    const good = vi.fn();
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    store.subscribe(bad);
    store.subscribe(good);

    expect(() =>
      store.commit((l) => ({ ...l, treeRevision: 1 }), "r"),
    ).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toBe(
      "Workspace host store listener failed",
    );
    errorSpy.mockRestore();
  });

  it("setTransientTree is visible through getLive but not through getSnapshot and does not notify", () => {
    const initial = snap();
    const store = new WorkspaceHostStore(initial);
    const transient = createWorkspacePane("transient-pane");
    const listener = vi.fn();
    store.subscribe(listener);

    store.setTransientTree(transient);

    expect(store.getLive().tree).toBe(transient);
    expect(store.getSnapshot().tree).toBe(initial.tree);
    expect(store.getSnapshot()).toBe(initial);
    expect(listener).not.toHaveBeenCalled();
    // 反向：getLive 连续两次返回同一对象（缓存稳定）。
    expect(store.getLive()).toBe(store.getLive());
  });

  it("commit clears the transient tree and publishes it when the recipe sets the tree", () => {
    const store = new WorkspaceHostStore(snap());
    const transient = createWorkspacePane("transient-pane");
    store.setTransientTree(transient);
    const listener = vi.fn();
    store.subscribe(listener);

    store.commit((published) => ({ ...published, tree: transient }), "dragEnd");

    expect(store.getSnapshot().tree).toBe(transient);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getLive()).toBe(store.getSnapshot());
  });

  it("a non-tree commit during a drag does not publish the transient tree", () => {
    const initial = snap();
    const store = new WorkspaceHostStore(initial);
    const transient = createWorkspacePane("transient-pane");
    store.setTransientTree(transient);
    const listener = vi.fn();
    store.subscribe(listener);

    store.commit(
      (published) => ({ ...published, focusedPaneId: "p9" }),
      "focus",
    );

    expect(store.getSnapshot().focusedPaneId).toBe("p9");
    expect(store.getSnapshot().tree).toBe(initial.tree);
    expect(store.getLive().tree).toBe(transient);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("records the reason and commit count of effective commits only", () => {
    const store = new WorkspaceHostStore(snap());

    store.commit((l) => ({ ...l, treeRevision: 1 }), "a");
    store.commit((live) => live, "b");
    store.commit((l) => ({ ...l, focusedPaneId: "p9" }), "c");

    expect(store.commitCount).toBe(2);
    expect(store.lastReason).toBe("c");
  });

  it("recipe receives the published snapshot, never the transient tree", () => {
    const initial = snap();
    const store = new WorkspaceHostStore(initial);
    const transient = createWorkspacePane("transient-pane");
    store.setTransientTree(transient);
    const seen: HostSnapshot[] = [];

    store.commit((published) => {
      seen.push(published);
      return { ...published, treeRevision: 5 };
    }, "r");

    expect(seen[0]).toBe(initial);
    expect(store.getSnapshot().tree).toBe(initial.tree);
    expect(store.getSnapshot().treeRevision).toBe(5);
    expect(store.getLive().tree).toBe(transient);
  });

  it("treats ptySessionsById as a snapshot field", () => {
    const store = new WorkspaceHostStore(createInitialHostSnapshot("p1"));
    const listener = vi.fn();
    store.subscribe(listener);

    store.commit(
      (live) => ({ ...live, ptySessionsById: live.ptySessionsById }),
      "same",
    );
    expect(listener).not.toHaveBeenCalled();
    expect(store.commitCount).toBe(0);

    store.commit(
      (live) => ({ ...live, ptySessionsById: { ...live.ptySessionsById } }),
      "new-object",
    );
    expect(listener).toHaveBeenCalledTimes(1);
    expect(createInitialHostSnapshot("p9").ptySessionsById).toEqual({});
  });
});

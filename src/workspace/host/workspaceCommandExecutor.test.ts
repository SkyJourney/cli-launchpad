import { describe, expect, it, vi } from "vitest";
import {
  addWorkspaceContentToPane,
  createWorkspacePane,
  findWorkspacePane,
  listWorkspacePanes,
  splitWorkspacePane,
} from "../../lib/ptyWorkspaceLayout";
import { WorkspaceContentCoordinator } from "../../lib/workspaceContentCoordinator";
import {
  createInitialHostSnapshot,
  WorkspaceHostStore,
} from "./workspaceHostStore";
import { createWorkspaceCommandExecutor } from "./workspaceCommandExecutor";

const FILE = { kind: "file" as const, documentId: "d1" };
const PTY = { kind: "pty" as const, slotId: "i1" };
const UNKNOWN = {
  kind: "unknown" as const,
  originalKind: "markdownPreview",
  raw: { source: "README.md" },
};
const SLOT = {
  instanceId: "i1",
  directoryId: 1,
  directoryPath: "C:/project",
  projectName: "Project",
  toolKey: "claude" as const,
  sequence: 1,
  title: { kind: "automatic" as const },
};

function setup(options: { restore?: boolean } = {}) {
  let tree = splitWorkspacePane(
    createWorkspacePane("pa"),
    "pa",
    "horizontal",
    "sp0",
    "pb",
  );
  tree = addWorkspaceContentToPane(tree, "pa", FILE);
  tree = addWorkspaceContentToPane(tree, "pa", PTY);
  tree = addWorkspaceContentToPane(tree, "pb", UNKNOWN);
  const store = new WorkspaceHostStore({
    ...createInitialHostSnapshot("pa"),
    tree,
    slots: [SLOT],
  });
  const coordinator = new WorkspaceContentCoordinator();
  let counter = 0;
  const newId = () => "u" + ++counter;
  const afterCommit = vi.fn();
  const schedulePersist = vi.fn();
  const executor = createWorkspaceCommandExecutor({
    store,
    coordinator,
    addSlot: (live, slot) => ({ ...live, slots: [...live.slots, slot] }),
    isRestoreInProgress: () => options.restore ?? false,
    afterCommit,
    newId,
    schedulePersist,
  });
  return {
    store,
    coordinator,
    executor,
    afterCommit,
    schedulePersist,
    newIdCount: () => counter,
  };
}

const paneOf = (store: WorkspaceHostStore, id: string) =>
  findWorkspacePane(store.getSnapshot().tree, id)!;

/** 生命周期状态里只有非 detaching 阶段带 owner；订阅者只关心 pane 归属。 */
const ownerPaneId = (state: unknown): string | undefined =>
  (state as { owner?: { paneId?: string } } | undefined)?.owner?.paneId;

describe("workspaceCommandExecutor", () => {
  it("focus sets the focused pane and syncs the active content", () => {
    const s = setup();

    expect(s.executor.execute({ type: "focus", paneId: "pb" })).toEqual({
      status: "applied",
      focusPaneId: "pb",
    });
    expect(s.store.getSnapshot().focusedPaneId).toBe("pb");
    expect(s.afterCommit).toHaveBeenCalledTimes(1);
    expect(s.afterCommit).toHaveBeenCalledWith(UNKNOWN);
    expect(s.store.lastReason).toBe("command:focus");
  });

  it("focus ignores a missing pane", () => {
    const s = setup();
    const before = s.store.commitCount;

    expect(s.executor.execute({ type: "focus", paneId: "nope" })).toEqual({
      status: "ignored",
      reason: "pane-missing",
    });
    expect(s.store.commitCount).toBe(before);
    expect(s.afterCommit).not.toHaveBeenCalled();
    expect(s.schedulePersist).not.toHaveBeenCalled();
  });

  it("activate sets the active content, focuses the pane and syncs the project context", () => {
    const s = setup();

    expect(
      s.executor.execute({ type: "activate", ref: FILE, paneId: "pa" }),
    ).toEqual({ status: "applied", focusPaneId: "pa" });
    expect(paneOf(s.store, "pa").activeContent).toEqual(FILE);
    expect(s.store.getSnapshot().focusedPaneId).toBe("pa");
    expect(s.afterCommit).toHaveBeenCalledTimes(1);
    expect(s.afterCommit).toHaveBeenCalledWith(FILE);
  });

  it("activate lets the reducer error propagate", () => {
    const s = setup();
    const before = s.store.commitCount;

    expect(() =>
      s.executor.execute({ type: "activate", ref: FILE, paneId: "pb" }),
    ).toThrow("Workspace content does not belong to pane");
    expect(s.store.commitCount).toBe(before);
    expect(s.afterCommit).not.toHaveBeenCalled();
  });

  it("activate of unknown content does not sync the project context", () => {
    const s = setup();

    expect(
      s.executor.execute({ type: "activate", ref: UNKNOWN, paneId: "pb" }),
    ).toEqual({ status: "applied", focusPaneId: "pb" });
    expect(s.store.getSnapshot().focusedPaneId).toBe("pb");
    expect(s.afterCommit).not.toHaveBeenCalled();
  });

  it("move relocates the content, registers the destination and focuses it", () => {
    const s = setup();
    s.coordinator.ensureAttached(FILE, {
      kind: "pane",
      windowLabel: "main",
      paneId: "pa",
    });
    const before = s.store.commitCount;

    expect(
      s.executor.execute({
        type: "move",
        ref: FILE,
        fromPaneId: "pa",
        toPaneId: "pb",
      }),
    ).toEqual({ status: "applied", focusPaneId: "pb" });
    expect(paneOf(s.store, "pb").contents).toContainEqual(FILE);
    expect(paneOf(s.store, "pa").contents).not.toContainEqual(FILE);
    expect(s.coordinator.get(FILE)).toMatchObject({
      phase: "attached",
      owner: { paneId: "pb" },
    });
    expect(s.afterCommit).toHaveBeenCalledTimes(1);
    expect(s.afterCommit).toHaveBeenCalledWith(FILE);
    expect(s.store.lastReason).toBe("command:move");
    expect(s.store.commitCount).toBe(before + 1);
  });

  it("move registers a never-registered source lazily", () => {
    const s = setup();
    expect(s.coordinator.get(FILE)).toBeUndefined();

    s.executor.execute({
      type: "move",
      ref: FILE,
      fromPaneId: "pa",
      toPaneId: "pb",
    });

    expect(s.coordinator.get(FILE)).toMatchObject({
      phase: "attached",
      owner: { paneId: "pb" },
    });
  });

  it("move to the same pane is ignored", () => {
    const s = setup();
    const before = s.store.commitCount;

    expect(
      s.executor.execute({
        type: "move",
        ref: FILE,
        fromPaneId: "pa",
        toPaneId: "pa",
      }),
    ).toEqual({ status: "ignored", reason: "same-pane" });
    expect(s.store.commitCount).toBe(before);
    expect(s.afterCommit).not.toHaveBeenCalled();
  });

  it("move ignores a missing source pane", () => {
    const s = setup();

    expect(
      s.executor.execute({
        type: "move",
        ref: FILE,
        fromPaneId: "nope",
        toPaneId: "pb",
      }),
    ).toEqual({ status: "ignored", reason: "pane-missing" });
    expect(s.coordinator.get(FILE)).toBeUndefined();
  });

  it("move ignores a missing destination pane", () => {
    const s = setup();

    expect(
      s.executor.execute({
        type: "move",
        ref: FILE,
        fromPaneId: "pa",
        toPaneId: "nope",
      }),
    ).toEqual({ status: "ignored", reason: "pane-missing" });
    expect(s.coordinator.get(FILE)).toBeUndefined();
  });

  it("move ignores content that is not in the source pane", () => {
    const s = setup();

    expect(
      s.executor.execute({
        type: "move",
        ref: FILE,
        fromPaneId: "pb",
        toPaneId: "pa",
      }),
    ).toEqual({ status: "ignored", reason: "content-not-in-pane" });
    expect(s.coordinator.get(FILE)).toBeUndefined();
  });

  it("move ignores unknown content", () => {
    const s = setup();
    const before = s.store.commitCount;

    expect(
      s.executor.execute({
        type: "move",
        ref: UNKNOWN,
        fromPaneId: "pb",
        toPaneId: "pa",
      }),
    ).toEqual({ status: "ignored", reason: "unknown-content" });
    expect(s.store.commitCount).toBe(before);
  });

  it("move is refused while the content is detaching", () => {
    const s = setup();
    s.coordinator.beginDetach(
      FILE,
      { kind: "pane", windowLabel: "main", paneId: "pa" },
      {
        kind: "window",
        windowLabel: "workspace-content-8e783338-f464-4b10-b15e-b534748c6241",
      },
      "t1",
    );
    const before = s.store.commitCount;

    expect(
      s.executor.execute({
        type: "move",
        ref: FILE,
        fromPaneId: "pa",
        toPaneId: "pb",
      }),
    ).toEqual({ status: "ignored", reason: "owner-not-pane" });
    expect(s.store.commitCount).toBe(before);
    expect(paneOf(s.store, "pa").contents).toContainEqual(FILE);
    expect(s.coordinator.get(FILE)?.phase).toBe("detaching");
  });

  it("split moves the content into a new focused pane created with fresh ids", () => {
    const s = setup();

    expect(
      s.executor.execute({
        type: "split",
        ref: FILE,
        fromPaneId: "pa",
        direction: "vertical",
      }),
    ).toEqual({ status: "applied", focusPaneId: "u1" });
    expect(
      listWorkspacePanes(s.store.getSnapshot().tree)
        .map((p) => p.id)
        .sort(),
    ).toEqual(["pa", "pb", "u1"]);
    expect(paneOf(s.store, "u1").contents).toContainEqual(FILE);
    expect(paneOf(s.store, "pa").contents).not.toContainEqual(FILE);
    expect(s.coordinator.get(FILE)).toMatchObject({
      phase: "attached",
      owner: { paneId: "u1" },
    });
    expect(s.afterCommit).toHaveBeenCalledTimes(1);
    expect(s.afterCommit).toHaveBeenCalledWith(FILE);
    expect(s.store.getSnapshot().focusedPaneId).toBe("u1");
  });

  it("split ignores unknown content", () => {
    const s = setup();

    expect(
      s.executor.execute({
        type: "split",
        ref: UNKNOWN,
        fromPaneId: "pb",
        direction: "vertical",
      }),
    ).toEqual({ status: "ignored", reason: "unknown-content" });
  });

  it("split ignores a missing source pane", () => {
    const s = setup();

    expect(
      s.executor.execute({
        type: "split",
        ref: FILE,
        fromPaneId: "nope",
        direction: "vertical",
      }),
    ).toEqual({ status: "ignored", reason: "pane-missing" });
  });

  it("split ignores content that is not in the source pane", () => {
    const s = setup();

    expect(
      s.executor.execute({
        type: "split",
        ref: FILE,
        fromPaneId: "pb",
        direction: "vertical",
      }),
    ).toEqual({ status: "ignored", reason: "content-not-in-pane" });
    expect(s.newIdCount()).toBe(0);
  });

  it("split is refused while the content is detaching", () => {
    const s = setup();
    s.coordinator.beginDetach(
      FILE,
      { kind: "pane", windowLabel: "main", paneId: "pa" },
      {
        kind: "window",
        windowLabel: "workspace-content-8e783338-f464-4b10-b15e-b534748c6241",
      },
      "t1",
    );
    const before = s.store.commitCount;

    expect(
      s.executor.execute({
        type: "split",
        ref: FILE,
        fromPaneId: "pa",
        direction: "vertical",
      }),
    ).toEqual({ status: "ignored", reason: "owner-not-pane" });
    expect(s.store.commitCount).toBe(before);
  });

  it("splitPane creates an empty focused pane and syncs the source active content after the commit", () => {
    const s = setup();
    const order: string[] = [];
    s.store.subscribe(() => order.push("commit"));
    s.afterCommit.mockImplementation(() => order.push("after"));

    expect(
      s.executor.execute({
        type: "splitPane",
        paneId: "pa",
        direction: "horizontal",
      }),
    ).toEqual({ status: "applied", focusPaneId: "u1" });
    expect(paneOf(s.store, "u1").contents).toEqual([]);
    expect(s.afterCommit).toHaveBeenCalledTimes(1);
    expect(s.afterCommit).toHaveBeenCalledWith(PTY);
    expect(order).toEqual(["commit", "after"]);
  });

  it("splitPane ignores a missing pane", () => {
    const s = setup();

    expect(
      s.executor.execute({
        type: "splitPane",
        paneId: "nope",
        direction: "horizontal",
      }),
    ).toEqual({ status: "ignored", reason: "pane-missing" });
    expect(s.newIdCount()).toBe(0);
  });

  it("place activates content that already lives in a pane", () => {
    const s = setup();
    s.store.commit(
      (live) => ({ ...live, focusedPaneId: "pb" }),
      "test:focus-pb",
    );

    expect(s.executor.execute({ type: "place", ref: FILE })).toEqual({
      status: "applied",
      focusPaneId: "pa",
    });
    expect(paneOf(s.store, "pa").activeContent).toEqual(FILE);
    expect(s.coordinator.get(FILE)).toMatchObject({ owner: { paneId: "pa" } });
    expect(s.afterCommit).not.toHaveBeenCalled();
  });

  it("place adds new content to the focused pane, or to the first pane when the focus is stale", () => {
    const NEW = { kind: "file" as const, documentId: "d2" };

    const focused = setup();
    focused.store.commit(
      (live) => ({ ...live, focusedPaneId: "pb" }),
      "test:focus-pb",
    );
    expect(focused.executor.execute({ type: "place", ref: NEW })).toEqual({
      status: "applied",
      focusPaneId: "pb",
    });
    expect(paneOf(focused.store, "pb").contents).toContainEqual(NEW);
    expect(paneOf(focused.store, "pb").activeContent).toEqual(NEW);
    expect(focused.coordinator.get(NEW)).toMatchObject({
      owner: { paneId: "pb" },
    });

    const stale = setup();
    stale.store.commit(
      (live) => ({ ...live, focusedPaneId: "gone" }),
      "test:stale",
    );
    const outcome = stale.executor.execute({ type: "place", ref: NEW });
    expect(outcome).toMatchObject({ status: "applied", focusPaneId: "pa" });
    expect(paneOf(stale.store, "pa").contents).toContainEqual(NEW);
  });

  it("launch adds the slot and the session to the focused pane in one commit and registers it", () => {
    const s = setup();
    const slot = { ...SLOT, instanceId: "i2", sequence: 2 };
    const before = s.store.commitCount;

    expect(s.executor.execute({ type: "launch", slot })).toEqual({
      status: "applied",
      focusPaneId: "pa",
    });
    expect(s.store.getSnapshot().slots.map((x) => x.instanceId)).toEqual([
      "i1",
      "i2",
    ]);
    expect(paneOf(s.store, "pa").contents).toContainEqual({
      kind: "pty",
      slotId: "i2",
    });
    // 反向：新会话成为目标 pane 的活动内容（偏离 3 依赖 addWorkspaceContentToPane 的这一行为）。
    expect(paneOf(s.store, "pa").activeContent).toEqual({
      kind: "pty",
      slotId: "i2",
    });
    expect(s.coordinator.get({ kind: "pty", slotId: "i2" })).toMatchObject({
      phase: "attached",
      owner: { paneId: "pa" },
    });
    expect(s.store.commitCount).toBe(before + 1);
    expect(s.afterCommit).not.toHaveBeenCalled();
  });

  it("launch is ignored while a backup restore is in progress", () => {
    const s = setup({ restore: true });
    const before = s.store.commitCount;

    expect(
      s.executor.execute({
        type: "launch",
        slot: { ...SLOT, instanceId: "i2" },
      }),
    ).toEqual({ status: "ignored", reason: "restore-in-progress" });
    expect(s.store.commitCount).toBe(before);
    expect(s.store.getSnapshot().slots).toHaveLength(1);
    expect(s.coordinator.get({ kind: "pty", slotId: "i2" })).toBeUndefined();
  });

  it("closeEmptyPane removes the pane, bumps the tree revision and falls back the focus", () => {
    const s = setup();
    s.store.commit(
      (live) => ({
        ...live,
        tree: addWorkspaceContentToPane(
          splitWorkspacePane(
            createWorkspacePane("pa"),
            "pa",
            "horizontal",
            "sp0",
            "pb",
          ),
          "pa",
          FILE,
        ),
        focusedPaneId: "pb",
      }),
      "test:empty-pb",
    );
    const revisionBefore = s.store.getSnapshot().treeRevision;

    expect(
      s.executor.execute({ type: "closeEmptyPane", paneId: "pb" }),
    ).toEqual({
      status: "applied",
      focusPaneId: "pa",
    });
    expect(
      listWorkspacePanes(s.store.getSnapshot().tree).map((p) => p.id),
    ).toEqual(["pa"]);
    expect(s.store.getSnapshot().treeRevision).toBe(revisionBefore + 1);
    expect(s.store.getSnapshot().focusedPaneId).toBe("pa");
    expect(s.afterCommit).toHaveBeenCalledTimes(1);
    expect(s.afterCommit).toHaveBeenCalledWith(FILE);

    // 反向：焦点留在 pa 时关闭空的 pb，不回退焦点，也不同步项目上下文。
    const kept = setup();
    kept.store.commit(
      (live) => ({
        ...live,
        tree: addWorkspaceContentToPane(
          splitWorkspacePane(
            createWorkspacePane("pa"),
            "pa",
            "horizontal",
            "sp0",
            "pb",
          ),
          "pa",
          FILE,
        ),
        focusedPaneId: "pa",
      }),
      "test:empty-pb-focus-pa",
    );
    expect(
      kept.executor.execute({ type: "closeEmptyPane", paneId: "pb" }),
    ).toEqual({
      status: "applied",
      focusPaneId: "pa",
    });
    expect(kept.afterCommit).not.toHaveBeenCalled();
  });

  it("closeEmptyPane ignores a pane that still has content", () => {
    const s = setup();
    const before = s.store.commitCount;

    expect(
      s.executor.execute({ type: "closeEmptyPane", paneId: "pa" }),
    ).toEqual({
      status: "ignored",
      reason: "pane-not-empty",
    });
    expect(s.store.commitCount).toBe(before);
  });

  it("closeEmptyPane ignores a missing pane", () => {
    const s = setup();

    expect(
      s.executor.execute({ type: "closeEmptyPane", paneId: "nope" }),
    ).toEqual({
      status: "ignored",
      reason: "pane-missing",
    });
  });

  it("schedules persistence once per effective commit and never for ignored commands", () => {
    const s = setup();

    // 有效的 move：焦点与树同时变化，提交一次。
    s.executor.execute({
      type: "move",
      ref: FILE,
      fromPaneId: "pa",
      toPaneId: "pb",
    });
    expect(s.schedulePersist).toHaveBeenCalledTimes(1);

    // 同 pane 的 move 被忽略：不提交、不调度。
    s.executor.execute({
      type: "move",
      ref: FILE,
      fromPaneId: "pb",
      toPaneId: "pb",
    });
    expect(s.schedulePersist).toHaveBeenCalledTimes(1);

    // 焦点由上一步已是 pb，改为 pa 才是有效提交。
    // 规格原文为“有效的 focus 到 pb”，与上一步 move 的结果冲突，此处改为 pa 以保留“一次有效、一次无效”的意图。
    s.executor.execute({ type: "focus", paneId: "pa" });
    expect(s.schedulePersist).toHaveBeenCalledTimes(2);

    // 重复聚焦 pa：快照字段未变，不产生提交，但提交后效果仍然执行。
    s.afterCommit.mockClear();
    s.executor.execute({ type: "focus", paneId: "pa" });
    expect(s.schedulePersist).toHaveBeenCalledTimes(2);
    expect(s.afterCommit).toHaveBeenCalledTimes(1);

    // 反向：不提供 schedulePersist 的执行器执行有效命令不抛错。
    const bare = createWorkspaceCommandExecutor({
      store: s.store,
      coordinator: s.coordinator,
      addSlot: (live, slot) => ({ ...live, slots: [...live.slots, slot] }),
      isRestoreInProgress: () => false,
      afterCommit: () => {},
      newId: () => "x",
    });
    expect(() => bare.execute({ type: "focus", paneId: "pb" })).not.toThrow();
    expect(s.store.getSnapshot().focusedPaneId).toBe("pb");
  });

  it("registers the destination in the coordinator before the store commit becomes visible", () => {
    // move：订阅者被通知时，coordinator 中已经登记目标 pane。
    const move = setup();
    const movesSeen: Array<string | undefined> = [];
    move.store.subscribe(() =>
      movesSeen.push(ownerPaneId(move.coordinator.get(FILE))),
    );
    move.executor.execute({
      type: "move",
      ref: FILE,
      fromPaneId: "pa",
      toPaneId: "pb",
    });
    expect(movesSeen).toEqual(["pb"]);

    // split：同样先登记新 pane 再提交。
    const split = setup();
    const splitsSeen: Array<string | undefined> = [];
    split.store.subscribe(() =>
      splitsSeen.push(ownerPaneId(split.coordinator.get(FILE))),
    );
    split.executor.execute({
      type: "split",
      ref: FILE,
      fromPaneId: "pa",
      direction: "vertical",
    });
    expect(splitsSeen).toEqual(["u1"]);

    // launch：同样先登记 PTY 所在 pane 再提交。
    const launch = setup();
    const launchesSeen: Array<string | undefined> = [];
    launch.store.subscribe(() =>
      launchesSeen.push(
        ownerPaneId(launch.coordinator.get({ kind: "pty", slotId: "i2" })),
      ),
    );
    launch.executor.execute({
      type: "launch",
      slot: { ...SLOT, instanceId: "i2", sequence: 2 },
    });
    expect(launchesSeen).toEqual(["pa"]);
  });
});

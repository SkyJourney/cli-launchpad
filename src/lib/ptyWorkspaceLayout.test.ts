import { describe, expect, it } from "vitest";
import {
  activateWorkspaceSession,
  addSessionToWorkspacePane,
  canSplitWorkspacePane,
  containsWorkspaceSession,
  createWorkspacePane,
  findWorkspacePane,
  isUsableWorkspaceSplitSizes,
  listWorkspacePanes,
  listVisibleWorkspaceSessionIds,
  moveWorkspaceSession,
  nextWorkspaceSessionSequence,
  removeEmptyWorkspacePane,
  removeWorkspaceSession,
  setWorkspaceSplitRatio,
  splitAndMoveWorkspaceSession,
  splitWorkspacePane,
  workspaceSplitSizes,
} from "./ptyWorkspaceLayout";

describe("PTY workspace split tree", () => {
  it("counts detached sessions in the project and CLI window sequence", () => {
    const allManagedSlots = [
      { directoryId: 42, toolKey: "codex", sequence: 1 },
      { directoryId: 42, toolKey: "codex", sequence: 2 },
      { directoryId: 7, toolKey: "codex", sequence: 8 },
      { directoryId: 42, toolKey: "claude", sequence: 5 },
      { directoryId: 42, toolKey: "hermes", sequence: 1 },
    ];

    expect(nextWorkspaceSessionSequence(allManagedSlots, 42, "codex")).toBe(3);
    expect(nextWorkspaceSessionSequence(allManagedSlots, 42, "agy")).toBe(1);
    expect(nextWorkspaceSessionSequence(allManagedSlots, 42, "hermes")).toBe(2);
  });

  it("converts a saved ratio into pane sizes excluding the sash", () => {
    expect(workspaceSplitSizes(0.7, 1008)).toEqual([700, 300]);
    expect(workspaceSplitSizes(Number.NaN, 1008)).toEqual([500, 500]);
    expect(workspaceSplitSizes(0.7, 4)).toEqual([0, 0]);
  });

  it("accepts only finite positive sizes for a two-pane resize", () => {
    expect(isUsableWorkspaceSplitSizes([700, 300])).toBe(true);
    expect(isUsableWorkspaceSplitSizes([0, 300])).toBe(false);
    expect(isUsableWorkspaceSplitSizes([700, Number.POSITIVE_INFINITY])).toBe(
      false,
    );
    expect(isUsableWorkspaceSplitSizes([700])).toBe(false);
  });

  it("splits a pane recursively and keeps existing sessions in that pane", () => {
    const root = addSessionToWorkspacePane(
      createWorkspacePane("root"),
      "root",
      "session-a",
    );
    const split = splitWorkspacePane(
      root,
      "root",
      "horizontal",
      "split-1",
      "pane-b",
    );

    expect(split.kind).toBe("split");
    if (split.kind !== "split") return;
    expect(split.first).toEqual({
      kind: "pane",
      id: "root",
      paneNumber: 1,
      sessionIds: ["session-a"],
      activeSessionId: "session-a",
    });
    expect(split.second).toEqual(createWorkspacePane("pane-b", 2));
    expect(listWorkspacePanes(split).map((pane) => pane.id)).toEqual([
      "root",
      "pane-b",
    ]);
  });

  it("assigns each session to one pane and rejects duplicate ownership", () => {
    const split = splitWorkspacePane(
      createWorkspacePane("root"),
      "root",
      "vertical",
      "split-1",
      "pane-b",
    );
    const withSession = addSessionToWorkspacePane(split, "pane-b", "session-a");

    expect(containsWorkspaceSession(withSession, "session-a")).toBe(true);
    expect(() =>
      addSessionToWorkspacePane(withSession, "root", "session-a"),
    ).toThrow("already assigned");
  });

  it("switches the active session only within its owning pane", () => {
    const withSessions = addSessionToWorkspacePane(
      addSessionToWorkspacePane(
        createWorkspacePane("root"),
        "root",
        "session-a",
      ),
      "root",
      "session-b",
    );
    const switched = activateWorkspaceSession(
      withSessions,
      "root",
      "session-a",
    );

    expect(findWorkspacePane(switched, "root")?.activeSessionId).toBe(
      "session-a",
    );
    expect(() =>
      activateWorkspaceSession(switched, "root", "session-missing"),
    ).toThrow("does not belong");
  });

  it("keeps each pane's selected terminal visible for independent resizing", () => {
    const split = splitWorkspacePane(
      createWorkspacePane("root"),
      "root",
      "horizontal",
      "split-1",
      "pane-b",
    );
    const populated = addSessionToWorkspacePane(
      addSessionToWorkspacePane(
        addSessionToWorkspacePane(split, "root", "session-a"),
        "root",
        "session-c",
      ),
      "pane-b",
      "session-b",
    );

    expect(listVisibleWorkspaceSessionIds(populated)).toEqual([
      "session-c",
      "session-b",
    ]);
    expect(
      listVisibleWorkspaceSessionIds(
        activateWorkspaceSession(populated, "root", "session-a"),
      ),
    ).toEqual(["session-a", "session-b"]);
  });

  it("moves a session between panes and selects the moved session", () => {
    const split = splitWorkspacePane(
      createWorkspacePane("root"),
      "root",
      "horizontal",
      "split-1",
      "pane-b",
    );
    const withSessions = addSessionToWorkspacePane(
      addSessionToWorkspacePane(
        addSessionToWorkspacePane(split, "root", "session-a"),
        "root",
        "session-b",
      ),
      "pane-b",
      "session-c",
    );

    const moved = moveWorkspaceSession(
      withSessions,
      "root",
      "pane-b",
      "session-a",
    );

    expect(findWorkspacePane(moved, "root")).toEqual({
      kind: "pane",
      id: "root",
      paneNumber: 1,
      sessionIds: ["session-b"],
      activeSessionId: "session-b",
    });
    expect(findWorkspacePane(moved, "pane-b")).toEqual({
      kind: "pane",
      id: "pane-b",
      paneNumber: 2,
      sessionIds: ["session-c", "session-a"],
      activeSessionId: "session-a",
    });
  });

  it("keeps an empty source pane when its only session moves", () => {
    const split = splitWorkspacePane(
      createWorkspacePane("root"),
      "root",
      "vertical",
      "split-1",
      "pane-b",
    );
    const withSession = addSessionToWorkspacePane(split, "root", "session-a");

    const moved = moveWorkspaceSession(
      withSession,
      "root",
      "pane-b",
      "session-a",
    );

    expect(findWorkspacePane(moved, "root")).toEqual(
      createWorkspacePane("root"),
    );
    expect(findWorkspacePane(moved, "pane-b")?.activeSessionId).toBe(
      "session-a",
    );
  });

  it("keeps an empty child pane after moving its only session", () => {
    const split = splitWorkspacePane(
      createWorkspacePane("root"),
      "root",
      "horizontal",
      "split-1",
      "pane-b",
    );
    const withSession = addSessionToWorkspacePane(split, "pane-b", "session-a");

    const moved = moveWorkspaceSession(
      withSession,
      "pane-b",
      "root",
      "session-a",
    );

    expect(listWorkspacePanes(moved)).toHaveLength(2);
    expect(findWorkspacePane(moved, "pane-b")?.sessionIds).toEqual([]);
    expect(findWorkspacePane(moved, "root")?.activeSessionId).toBe("session-a");
  });

  it("activates a session when asked to move it to its current pane", () => {
    const withSessions = addSessionToWorkspacePane(
      addSessionToWorkspacePane(
        createWorkspacePane("root"),
        "root",
        "session-a",
      ),
      "root",
      "session-b",
    );

    const activated = moveWorkspaceSession(
      withSessions,
      "root",
      "root",
      "session-a",
    );

    expect(findWorkspacePane(activated, "root")?.activeSessionId).toBe(
      "session-a",
    );
  });

  it("rejects moves when the source, target, or session is invalid", () => {
    const split = splitWorkspacePane(
      createWorkspacePane("root"),
      "root",
      "horizontal",
      "split-1",
      "pane-b",
    );
    const withSession = addSessionToWorkspacePane(split, "root", "session-a");

    expect(() =>
      moveWorkspaceSession(withSession, "missing", "pane-b", "session-a"),
    ).toThrow("does not belong");
    expect(() =>
      moveWorkspaceSession(withSession, "root", "missing", "session-a"),
    ).toThrow("pane not found");
    expect(() =>
      moveWorkspaceSession(withSession, "root", "pane-b", "missing"),
    ).toThrow("does not belong");
  });

  it("splits a pane and moves the selected session into the new pane", () => {
    const withSessions = addSessionToWorkspacePane(
      addSessionToWorkspacePane(
        createWorkspacePane("root"),
        "root",
        "session-a",
      ),
      "root",
      "session-b",
    );

    const splitAndMoved = splitAndMoveWorkspaceSession(
      withSessions,
      "root",
      "session-a",
      "horizontal",
      "split-1",
      "pane-b",
    );

    expect(listWorkspacePanes(splitAndMoved).map((pane) => pane.id)).toEqual([
      "root",
      "pane-b",
    ]);
    expect(findWorkspacePane(splitAndMoved, "root")).toEqual({
      kind: "pane",
      id: "root",
      paneNumber: 1,
      sessionIds: ["session-b"],
      activeSessionId: "session-b",
    });
    expect(findWorkspacePane(splitAndMoved, "pane-b")).toEqual({
      kind: "pane",
      id: "pane-b",
      paneNumber: 2,
      sessionIds: ["session-a"],
      activeSessionId: "session-a",
    });
  });

  it("rejects split-and-move when the selected session is outside the pane", () => {
    expect(() =>
      splitAndMoveWorkspaceSession(
        createWorkspacePane("root"),
        "root",
        "missing",
        "vertical",
        "split-1",
        "pane-b",
      ),
    ).toThrow("does not belong");
  });

  it("selects the adjacent tab if the active session exits", () => {
    const withSessions = addSessionToWorkspacePane(
      addSessionToWorkspacePane(
        createWorkspacePane("root"),
        "root",
        "session-a",
      ),
      "root",
      "session-b",
    );

    expect(
      findWorkspacePane(
        removeWorkspaceSession(withSessions, "session-b"),
        "root",
      )?.activeSessionId,
    ).toBe("session-a");
  });

  it("keeps an empty child pane after its final session exits", () => {
    const split = splitWorkspacePane(
      createWorkspacePane("root"),
      "root",
      "horizontal",
      "split-1",
      "pane-b",
    );
    const withSession = addSessionToWorkspacePane(split, "pane-b", "session-a");
    const afterExit = removeWorkspaceSession(withSession, "session-a");

    expect(listWorkspacePanes(afterExit).map((pane) => pane.id)).toEqual([
      "root",
      "pane-b",
    ]);
    expect(findWorkspacePane(afterExit, "pane-b")).toEqual(
      createWorkspacePane("pane-b", 2),
    );
  });

  it("lets the user close an unused empty pane without touching other sessions", () => {
    const split = splitWorkspacePane(
      createWorkspacePane("root"),
      "root",
      "horizontal",
      "split-1",
      "pane-b",
    );
    const withSession = addSessionToWorkspacePane(split, "root", "session-a");

    const afterClose = removeEmptyWorkspacePane(withSession, "pane-b");
    expect(listWorkspacePanes(afterClose).map((pane) => pane.id)).toEqual([
      "root",
    ]);
    expect(containsWorkspaceSession(afterClose, "session-a")).toBe(true);
    expect(() => removeEmptyWorkspacePane(withSession, "root")).toThrow(
      "still has sessions",
    );
  });

  it("closes a nested empty pane and preserves the surrounding split tree", () => {
    const firstSplit = splitWorkspacePane(
      createWorkspacePane("root"),
      "root",
      "horizontal",
      "split-1",
      "pane-b",
    );
    const nestedSplit = splitWorkspacePane(
      firstSplit,
      "pane-b",
      "vertical",
      "split-2",
      "pane-c",
    );
    const withSession = addSessionToWorkspacePane(
      nestedSplit,
      "pane-b",
      "session-b",
    );
    const afterClose = removeEmptyWorkspacePane(withSession, "pane-c");

    expect(listWorkspacePanes(afterClose).map((pane) => pane.id)).toEqual([
      "root",
      "pane-b",
    ]);
    expect(containsWorkspaceSession(afterClose, "session-b")).toBe(true);
  });

  it("promotes the surviving nested split after closing the opposite root pane", () => {
    const sideBySide = splitWorkspacePane(
      createWorkspacePane("pane-left", 4),
      "pane-left",
      "horizontal",
      "split-left-right",
      "pane-right-top",
      1,
    );
    const withRightColumnStacked = splitWorkspacePane(
      sideBySide,
      "pane-right-top",
      "vertical",
      "split-right-up-down",
      "pane-right-bottom",
      2,
    );
    const resized = setWorkspaceSplitRatio(
      withRightColumnStacked,
      "split-right-up-down",
      0.63,
    );

    const afterClosingLeft = removeEmptyWorkspacePane(resized, "pane-left");

    expect(afterClosingLeft).toEqual(
      resized.kind === "split" ? resized.second : null,
    );
    expect(afterClosingLeft.kind).toBe("split");
    if (afterClosingLeft.kind !== "split") return;
    expect(afterClosingLeft.id).toBe("split-right-up-down");
    expect(afterClosingLeft.direction).toBe("vertical");
    expect(afterClosingLeft.ratio).toBe(0.63);
    expect(listWorkspacePanes(afterClosingLeft).map((pane) => pane.id)).toEqual(
      ["pane-right-top", "pane-right-bottom"],
    );

    const afterClosingTop = removeEmptyWorkspacePane(
      afterClosingLeft,
      "pane-right-top",
    );
    expect(afterClosingTop).toEqual(
      createWorkspacePane("pane-right-bottom", 2),
    );

    const splitAgain = splitWorkspacePane(
      afterClosingTop,
      "pane-right-bottom",
      "horizontal",
      "split-again",
      "pane-new",
    );
    expect(removeEmptyWorkspacePane(splitAgain, "pane-new")).toEqual(
      afterClosingTop,
    );
  });

  it("promotes a horizontal child split after closing the other vertical pane", () => {
    const topBottom = splitWorkspacePane(
      createWorkspacePane("pane-top", 1),
      "pane-top",
      "vertical",
      "split-top-bottom",
      "pane-bottom-left",
      1,
    );
    const withBottomRow = splitWorkspacePane(
      topBottom,
      "pane-bottom-left",
      "horizontal",
      "split-bottom-left-right",
      "pane-bottom-right",
      2,
    );
    const resized = setWorkspaceSplitRatio(
      withBottomRow,
      "split-bottom-left-right",
      0.61,
    );

    const afterClosingTop = removeEmptyWorkspacePane(resized, "pane-top");

    expect(afterClosingTop).toEqual(
      resized.kind === "split" ? resized.second : null,
    );
    expect(afterClosingTop.kind).toBe("split");
    if (afterClosingTop.kind !== "split") return;
    expect(afterClosingTop.id).toBe("split-bottom-left-right");
    expect(afterClosingTop.direction).toBe("horizontal");
    expect(afterClosingTop.ratio).toBe(0.61);
    expect(listWorkspacePanes(afterClosingTop).map((pane) => pane.id)).toEqual([
      "pane-bottom-left",
      "pane-bottom-right",
    ]);
  });

  it("keeps surviving pane numbers and reuses the smallest vacant number", () => {
    const pane123 = splitWorkspacePane(
      splitWorkspacePane(
        createWorkspacePane("root"),
        "root",
        "horizontal",
        "split-1",
        "pane-2",
      ),
      "pane-2",
      "vertical",
      "split-2",
      "pane-3",
    );
    const afterClosingPane2 = removeEmptyWorkspacePane(pane123, "pane-2");

    expect(
      listWorkspacePanes(afterClosingPane2).map((pane) => [
        pane.id,
        pane.paneNumber,
      ]),
    ).toEqual([
      ["root", 1],
      ["pane-3", 3],
    ]);

    const afterCreatingPane = splitWorkspacePane(
      afterClosingPane2,
      "root",
      "horizontal",
      "split-3",
      "pane-2-reused",
    );
    expect(findWorkspacePane(afterCreatingPane, "root")?.paneNumber).toBe(1);
    expect(
      findWorkspacePane(afterCreatingPane, "pane-2-reused")?.paneNumber,
    ).toBe(2);
    expect(findWorkspacePane(afterCreatingPane, "pane-3")?.paneNumber).toBe(3);
  });

  it("keeps all panes and sibling sessions when one of three sessions exits", () => {
    const firstSplit = splitWorkspacePane(
      createWorkspacePane("root"),
      "root",
      "horizontal",
      "split-1",
      "pane-b",
    );
    const nested = splitWorkspacePane(
      firstSplit,
      "pane-b",
      "vertical",
      "split-2",
      "pane-c",
    );
    const populated = addSessionToWorkspacePane(
      addSessionToWorkspacePane(
        addSessionToWorkspacePane(nested, "root", "session-a"),
        "pane-b",
        "session-b",
      ),
      "pane-c",
      "session-c",
    );
    const afterExit = removeWorkspaceSession(populated, "session-c");

    expect(listWorkspacePanes(afterExit).map((pane) => pane.id)).toEqual([
      "root",
      "pane-b",
      "pane-c",
    ]);
    expect(containsWorkspaceSession(afterExit, "session-a")).toBe(true);
    expect(containsWorkspaceSession(afterExit, "session-b")).toBe(true);
    expect(containsWorkspaceSession(afterExit, "session-c")).toBe(false);
    expect(findWorkspacePane(afterExit, "pane-c")).toEqual(
      createWorkspacePane("pane-c", 3),
    );
  });

  it("records draggable split ratios and clamps invalid boundaries", () => {
    const split = splitWorkspacePane(
      createWorkspacePane("root"),
      "root",
      "vertical",
      "split-1",
      "pane-b",
    );
    const resized = setWorkspaceSplitRatio(split, "split-1", 0.7);
    const clamped = setWorkspaceSplitRatio(resized, "split-1", 1.5);

    expect(resized.kind === "split" && resized.ratio).toBe(0.7);
    expect(clamped.kind === "split" && clamped.ratio).toBe(0.95);
  });

  it("requires enough width for two horizontally split panes and a sash", () => {
    expect(canSplitWorkspacePane(408, 120, "horizontal")).toBe(true);
    expect(canSplitWorkspacePane(407, 900, "horizontal")).toBe(false);
  });

  it("requires enough height for two vertically split panes and a sash", () => {
    expect(canSplitWorkspacePane(120, 308, "vertical")).toBe(true);
    expect(canSplitWorkspacePane(900, 307, "vertical")).toBe(false);
  });

  it("checks only the dimension used by the requested split direction", () => {
    expect(canSplitWorkspacePane(408, 40, "horizontal")).toBe(true);
    expect(canSplitWorkspacePane(40, 308, "vertical")).toBe(true);
  });

  it("keeps an empty root pane when its last session exits", () => {
    const withSession = addSessionToWorkspacePane(
      createWorkspacePane("root"),
      "root",
      "session-a",
    );

    expect(removeWorkspaceSession(withSession, "session-a")).toEqual(
      createWorkspacePane("root"),
    );
  });
});

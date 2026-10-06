import { describe, expect, it } from "vitest";
import {
  type WorkspaceNode,
  activateWorkspaceSession,
  activateWorkspaceFile,
  addWorkspaceFileToPane,
  addSessionToWorkspacePane,
  canSplitWorkspacePane,
  containsWorkspaceSession,
  createWorkspacePane,
  findWorkspacePane,
  isUsableWorkspaceSplitSizes,
  listWorkspacePanes,
  listVisibleWorkspaceSessionIds,
  moveWorkspaceSession,
  moveWorkspaceFileToPane,
  placeContentExclusively,
  splitAndMoveWorkspaceFile,
  nextWorkspaceSessionSequence,
  removeEmptyWorkspacePane,
  removeWorkspaceSession,
  removeWorkspaceFileFromPane,
  removeWorkspaceContentFromTree,
  remapWorkspaceFileIds,
  setWorkspaceSplitRatio,
  splitAndMoveWorkspaceSession,
  splitWorkspacePane,
  splitWorkspaceContentSequence,
  workspacePaneOtherContents,
  workspaceSplitSizes,
} from "./ptyWorkspaceLayout";

describe("PTY workspace split tree", () => {
  it("keeps mixed PTY and file tabs in one ordered overflow sequence", () => {
    const entries = [
      { content: { kind: "pty", slotId: "terminal-a" }, label: "Terminal" },
      { content: { kind: "file", documentId: "file-a" }, label: "README" },
      { content: { kind: "pty", slotId: "terminal-b" }, label: "Terminal 2" },
    ] as const;

    expect(
      splitWorkspaceContentSequence(entries, {
        kind: "file",
        documentId: "file-a",
      }),
    ).toEqual({
      before: [entries[0]],
      active: entries[1],
      after: [entries[2]],
    });
  });

  it("puts all resolvable content in overflow if the active reference is missing", () => {
    const entries = [
      { content: { kind: "file", documentId: "file-a" }, label: "README" },
    ] as const;

    expect(
      splitWorkspaceContentSequence(entries, {
        kind: "pty",
        slotId: "missing-terminal",
      }),
    ).toEqual({ before: [], after: [...entries] });
  });

  it("includes all content kinds when selecting other pane contents", () => {
    const contents = [
      { kind: "pty", slotId: "terminal-a" },
      { kind: "file", documentId: "file-a" },
      { kind: "pty", slotId: "terminal-b" },
    ] as const;

    expect(
      workspacePaneOtherContents(contents, {
        kind: "file",
        documentId: "file-a",
      }),
    ).toEqual([contents[0], contents[2]]);
  });

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
      contents: [{ kind: "pty", slotId: "session-a" }],
      activeContent: { kind: "pty", slotId: "session-a" },
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

    expect(findWorkspacePane(switched, "root")?.activeContent).toEqual({
      kind: "pty",
      slotId: "session-a",
    });
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
      contents: [{ kind: "pty", slotId: "session-b" }],
      activeContent: { kind: "pty", slotId: "session-b" },
    });
    expect(findWorkspacePane(moved, "pane-b")).toEqual({
      kind: "pane",
      id: "pane-b",
      paneNumber: 2,
      contents: [
        { kind: "pty", slotId: "session-c" },
        { kind: "pty", slotId: "session-a" },
      ],
      activeContent: { kind: "pty", slotId: "session-a" },
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
    expect(findWorkspacePane(moved, "pane-b")?.activeContent).toEqual({
      kind: "pty",
      slotId: "session-a",
    });
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
    expect(findWorkspacePane(moved, "pane-b")?.contents).toEqual([]);
    expect(findWorkspacePane(moved, "root")?.activeContent).toEqual({
      kind: "pty",
      slotId: "session-a",
    });
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

    expect(findWorkspacePane(activated, "root")?.activeContent).toEqual({
      kind: "pty",
      slotId: "session-a",
    });
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
      contents: [{ kind: "pty", slotId: "session-b" }],
      activeContent: { kind: "pty", slotId: "session-b" },
    });
    expect(findWorkspacePane(splitAndMoved, "pane-b")).toEqual({
      kind: "pane",
      id: "pane-b",
      paneNumber: 2,
      contents: [{ kind: "pty", slotId: "session-a" }],
      activeContent: { kind: "pty", slotId: "session-a" },
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
      )?.activeContent,
    ).toEqual({ kind: "pty", slotId: "session-a" });
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

  it("switches pane content between PTY and file while keeping both references", () => {
    const withSession = addSessionToWorkspacePane(
      createWorkspacePane("root"),
      "root",
      "session-a",
    );
    const withFile = addWorkspaceFileToPane(withSession, "root", "file-a");
    expect(listVisibleWorkspaceSessionIds(withFile)).toEqual([]);

    const backToPty = activateWorkspaceSession(withFile, "root", "session-a");
    expect(listVisibleWorkspaceSessionIds(backToPty)).toEqual(["session-a"]);
    const backToFile = activateWorkspaceFile(backToPty, "root", "file-a");
    expect(findWorkspacePane(backToFile, "root")?.contents).toEqual([
      { kind: "pty", slotId: "session-a" },
      { kind: "file", documentId: "file-a" },
    ]);
    expect(listVisibleWorkspaceSessionIds(backToFile)).toEqual([]);
  });

  it("remaps preset document references to current live ids without duplicates", () => {
    const withPresetFile = addWorkspaceFileToPane(
      createWorkspacePane("root"),
      "root",
      "preset-file",
    );
    const withBothIds = addWorkspaceFileToPane(
      withPresetFile,
      "root",
      "live-file",
    );
    const active = activateWorkspaceFile(withBothIds, "root", "preset-file");

    const remapped = remapWorkspaceFileIds(
      active,
      new Map([["preset-file", "live-file"]]),
    );

    expect(remapped).toMatchObject({
      contents: [{ kind: "file", documentId: "live-file" }],
      activeContent: { kind: "file", documentId: "live-file" },
    });
  });

  it("moves a file tab between panes and activates it in the destination", () => {
    const first = addWorkspaceFileToPane(
      createWorkspacePane("first"),
      "first",
      "file-a",
    );
    const split = splitWorkspacePane(
      first,
      "first",
      "horizontal",
      "split",
      "second",
    );

    const moved = moveWorkspaceFileToPane(split, "first", "second", "file-a");

    expect(findWorkspacePane(moved, "first")?.contents).toEqual([]);
    expect(findWorkspacePane(moved, "second")).toMatchObject({
      contents: [{ kind: "file", documentId: "file-a" }],
      activeContent: { kind: "file", documentId: "file-a" },
    });
  });

  it("splits a pane and moves the selected file into the new pane", () => {
    const withFile = addWorkspaceFileToPane(
      createWorkspacePane("source"),
      "source",
      "file-a",
    );
    const moved = splitAndMoveWorkspaceFile(
      withFile,
      "source",
      "file-a",
      "horizontal",
      "split-a",
      "destination",
    );

    expect(findWorkspacePane(moved, "source")).toMatchObject({
      contents: [],
      activeContent: null,
    });
    expect(findWorkspacePane(moved, "destination")).toMatchObject({
      contents: [{ kind: "file", documentId: "file-a" }],
      activeContent: { kind: "file", documentId: "file-a" },
    });
  });

  it("removes a file from its pane after the detached window is ready", () => {
    const withFile = addWorkspaceFileToPane(
      createWorkspacePane("root"),
      "root",
      "file-a",
    );
    const detached = removeWorkspaceContentFromTree(withFile, {
      kind: "file",
      documentId: "file-a",
    });
    expect(findWorkspacePane(detached, "root")).toMatchObject({
      contents: [],
      activeContent: null,
    });
  });

  it("places a returned file only in its requested pane", () => {
    const first = addWorkspaceFileToPane(
      createWorkspacePane("first"),
      "first",
      "file-a",
    );
    const split = splitWorkspacePane(
      first,
      "first",
      "horizontal",
      "split",
      "second",
    );
    const staleDuplicate = addWorkspaceFileToPane(split, "first", "file-a");

    const returned = placeContentExclusively(staleDuplicate, "second", {
      kind: "file",
      documentId: "file-a",
    });

    expect(findWorkspacePane(returned, "first")?.contents).toEqual([]);
    expect(findWorkspacePane(returned, "second")?.contents).toEqual([
      { kind: "file", documentId: "file-a" },
    ]);
  });

  it("removes every stale file reference before exclusive placement", () => {
    const file = { kind: "file", documentId: "file-a" } as const;
    const tree: WorkspaceNode = {
      kind: "split",
      id: "root",
      direction: "horizontal",
      ratio: 0.5,
      first: {
        kind: "pane",
        id: "first",
        paneNumber: 1,
        contents: [file, file],
        activeContent: file,
      },
      second: {
        kind: "pane",
        id: "second",
        paneNumber: 2,
        contents: [file],
        activeContent: file,
      },
    };

    const placed = placeContentExclusively(tree, "second", file);

    expect(findWorkspacePane(placed, "first")?.contents).toEqual([]);
    expect(findWorkspacePane(placed, "second")?.contents).toEqual([file]);
  });

  it("falls back to an open file when the active PTY exits", () => {
    const mixed = addWorkspaceFileToPane(
      addSessionToWorkspacePane(
        createWorkspacePane("root"),
        "root",
        "session-a",
      ),
      "root",
      "file-a",
    );
    const showingPty = activateWorkspaceSession(mixed, "root", "session-a");
    const afterExit = removeWorkspaceSession(showingPty, "session-a");

    expect(findWorkspacePane(afterExit, "root")?.activeContent).toEqual({
      kind: "file",
      documentId: "file-a",
    });
  });

  it("chooses an open PTY or neighboring file when closing the active file", () => {
    const mixed = addWorkspaceFileToPane(
      addWorkspaceFileToPane(
        addSessionToWorkspacePane(
          createWorkspacePane("root"),
          "root",
          "session-a",
        ),
        "root",
        "file-a",
      ),
      "root",
      "file-b",
    );
    const closedFile = removeWorkspaceFileFromPane(mixed, "root", "file-b");
    expect(findWorkspacePane(closedFile, "root")?.activeContent).toEqual({
      kind: "file",
      documentId: "file-a",
    });

    const closedLastFile = removeWorkspaceFileFromPane(
      closedFile,
      "root",
      "file-a",
    );
    expect(findWorkspacePane(closedLastFile, "root")?.activeContent).toEqual({
      kind: "pty",
      slotId: "session-a",
    });
  });

  it.each([
    ["first", "second"],
    ["second", "first"],
  ] as const)(
    "allows a file close to traverse an unrelated pane (%s pane owns the file)",
    (ownerPaneId, otherPaneId) => {
      const split = splitWorkspacePane(
        createWorkspacePane("first"),
        "first",
        "horizontal",
        "split",
        "second",
      );
      const withFile = addWorkspaceFileToPane(split, ownerPaneId, "file-a");

      const afterOwner = removeWorkspaceFileFromPane(
        withFile,
        ownerPaneId,
        "file-a",
      );
      const afterOther = removeWorkspaceFileFromPane(
        afterOwner,
        otherPaneId,
        "file-a",
      );

      expect(
        listWorkspacePanes(afterOther).every((pane) =>
          pane.contents.every(
            (content) =>
              content.kind !== "file" || content.documentId !== "file-a",
          ),
        ),
      ).toBe(true);
    },
  );
});

import { describe, expect, it } from "vitest";
import {
  collectAppExitImpacts,
  shouldExitWithoutPrompt,
} from "./appExitImpacts";

const documents = [
  {
    id: "attached",
    directoryId: 1,
    directoryPath: "C:/project",
    relativePath: "draft.md",
  },
  {
    id: "detached",
    directoryId: 1,
    directoryPath: "C:/project",
    relativePath: "notes.md",
  },
];

describe("collectAppExitImpacts", () => {
  it("combines running PTYs with dirty attached and mirrored detached files", () => {
    const impacts = collectAppExitImpacts({
      ptyCount: 2,
      documents,
      buffers: {
        attached: {
          kind: "text",
          epoch: 0,
          version: 1,
          content: "draft",
          savedContent: "old",
          revision: "1",
          saving: false,
        },
        detached: {
          kind: "text",
          epoch: 0,
          version: 1,
          content: "notes",
          savedContent: "old notes",
          revision: "1",
          saving: false,
        },
      },
    });

    expect(impacts).toEqual({
      ptyCount: 2,
      dirtyFiles: [
        { documentId: "attached", relativePath: "draft.md" },
        { documentId: "detached", relativePath: "notes.md" },
      ],
    });
  });

  it("counts a child that failed to flush as dirty even with a clean stale mirror", () => {
    const impacts = collectAppExitImpacts({
      ptyCount: 0,
      documents,
      buffers: {
        detached: {
          kind: "text",
          epoch: 0,
          version: 0,
          content: "old notes",
          savedContent: "old notes",
          revision: "1",
          saving: false,
        },
      },
      uncertainDocumentIds: ["detached", "missing"],
    });

    expect(impacts.ptyCount).toBe(0);
    expect(impacts.dirtyFiles).toEqual([
      { documentId: "detached", relativePath: "notes.md" },
      { documentId: "missing", relativePath: "missing" },
    ]);
  });
});

describe("shouldExitWithoutPrompt", () => {
  it("allows an immediate exit only when no PTY or dirty file remains", () => {
    expect(shouldExitWithoutPrompt({ ptyCount: 0, dirtyFiles: [] })).toBe(true);
    expect(shouldExitWithoutPrompt({ ptyCount: 1, dirtyFiles: [] })).toBe(
      false,
    );
    expect(
      shouldExitWithoutPrompt({
        ptyCount: 0,
        dirtyFiles: [{ documentId: "doc-1", relativePath: "draft.md" }],
      }),
    ).toBe(false);
  });
});

describe("shouldExitWithoutPrompt with execution tasks", () => {
  it("prompts when execution tasks are running even with nothing else at risk", () => {
    expect(
      shouldExitWithoutPrompt({
        ptyCount: 0,
        dirtyFiles: [],
        executionTaskCount: 2,
      }),
    ).toBe(false);
    // 反向断言：任务数为 0 时仍可静默退出。
    expect(
      shouldExitWithoutPrompt({
        ptyCount: 0,
        dirtyFiles: [],
        executionTaskCount: 0,
      }),
    ).toBe(true);
  });

  it("keeps the legacy shape working when the task count is absent", () => {
    expect(shouldExitWithoutPrompt({ ptyCount: 0, dirtyFiles: [] })).toBe(true);
    expect(shouldExitWithoutPrompt({ ptyCount: 1, dirtyFiles: [] })).toBe(
      false,
    );
    expect(
      shouldExitWithoutPrompt({
        ptyCount: 0,
        dirtyFiles: [{ documentId: "d", relativePath: "a" }],
      }),
    ).toBe(false);
  });

  it("does not add the task count to the collected impacts", () => {
    const result = collectAppExitImpacts({
      ptyCount: 1,
      documents,
      buffers: {},
    });

    expect(result).toEqual({ ptyCount: 1, dirtyFiles: [] });
    expect(result).not.toHaveProperty("executionTaskCount");
  });
});

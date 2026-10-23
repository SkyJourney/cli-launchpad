import { describe, expect, it } from "vitest";
import {
  collectAppExitImpacts,
  mergeExitFlushResults,
  shouldExitWithoutPrompt,
} from "./appExitImpacts";
import type { WorkspaceFileBuffer } from "./workspaceFileBuffer";

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

describe("mergeExitFlushResults", () => {
  const doc = {
    id: "d1",
    directoryId: 1,
    directoryPath: "C:/project",
    relativePath: "a.txt",
  };
  const textBuffer = (
    overrides: Partial<WorkspaceFileBuffer> = {},
  ): WorkspaceFileBuffer => ({
    kind: "text",
    epoch: 0,
    version: 0,
    content: "x",
    savedContent: "x",
    revision: "1",
    saving: false,
    ...overrides,
  });

  it("marks a window that did not answer as uncertain and leaves the buffers untouched", () => {
    const buffers = { d1: textBuffer() };
    const result = mergeExitFlushResults({
      documents: [doc],
      buffers,
      outcomes: [{ documentId: "d1", response: null }],
    });
    expect(result.uncertainDocumentIds).toEqual(["d1"]);
    expect(result.buffers).toBe(buffers);
    expect(buffers.d1).toEqual(textBuffer());
  });

  it("takes the newer buffer from the window without mutating the input", () => {
    const current = textBuffer({ version: 1 });
    const incoming = textBuffer({
      version: 2,
      content: "from window",
      savedContent: "x",
    });
    const buffers = { d1: current };
    const result = mergeExitFlushResults({
      documents: [doc],
      buffers,
      outcomes: [
        {
          documentId: "d1",
          response: { fileDocument: doc, fileBuffer: incoming },
        },
      ],
    });
    expect(result.buffers.d1).toBe(incoming);
    expect(result.buffers).not.toBe(buffers);
    expect(buffers.d1).toBe(current);
    expect(result.uncertainDocumentIds).toEqual([]);
  });

  it("ignores an answer that is not newer than the host buffer", () => {
    const buffers = { d1: textBuffer({ version: 5 }) };
    for (const version of [5, 4]) {
      const result = mergeExitFlushResults({
        documents: [doc],
        buffers,
        outcomes: [
          {
            documentId: "d1",
            response: {
              fileDocument: doc,
              fileBuffer: textBuffer({ version, content: "stale" }),
            },
          },
        ],
      });
      expect(result.buffers).toBe(buffers);
      expect(result.uncertainDocumentIds).toEqual([]);
    }
    const newer = mergeExitFlushResults({
      documents: [doc],
      buffers,
      outcomes: [
        {
          documentId: "d1",
          response: {
            fileDocument: doc,
            fileBuffer: textBuffer({ version: 6 }),
          },
        },
      ],
    });
    expect(newer.buffers.d1.version).toBe(6);
  });

  it("treats an answer for a different project file as uncertain", () => {
    const buffers = { d1: textBuffer({ version: 1 }) };
    const newer = textBuffer({ version: 9, content: "newer" });
    const differentDocuments = [
      { ...doc, directoryId: 2 },
      { ...doc, directoryPath: "C:/other" },
      { ...doc, relativePath: "b.txt" },
    ];
    for (const fileDocument of differentDocuments) {
      const result = mergeExitFlushResults({
        documents: [doc],
        buffers,
        outcomes: [
          { documentId: "d1", response: { fileDocument, fileBuffer: newer } },
        ],
      });
      expect(result.uncertainDocumentIds).toEqual(["d1"]);
      expect(result.buffers).toBe(buffers);
    }
    const sameDocument = mergeExitFlushResults({
      documents: [doc],
      buffers,
      outcomes: [
        {
          documentId: "d1",
          response: { fileDocument: { ...doc }, fileBuffer: newer },
        },
      ],
    });
    expect(sameDocument.uncertainDocumentIds).toEqual([]);
  });

  it("treats an answer for a document that is no longer open as uncertain", () => {
    const buffers: Record<string, WorkspaceFileBuffer> = {};
    const result = mergeExitFlushResults({
      documents: [],
      buffers,
      outcomes: [
        {
          documentId: "d1",
          response: {
            fileDocument: doc,
            fileBuffer: textBuffer({ version: 3 }),
          },
        },
      ],
    });
    expect(result.uncertainDocumentIds).toEqual(["d1"]);
    expect(result.buffers).toBe(buffers);
    expect(Object.keys(result.buffers)).toEqual([]);
  });

  it("handles several windows independently and feeds the collector", () => {
    const documents = [
      doc,
      { ...doc, id: "d2", relativePath: "b.txt" },
      { ...doc, id: "d3", relativePath: "c.txt" },
    ];
    const buffers = {
      d1: textBuffer({ version: 1 }),
      d2: textBuffer({ version: 1 }),
      d3: textBuffer({ version: 1 }),
    };
    const result = mergeExitFlushResults({
      documents,
      buffers,
      outcomes: [
        { documentId: "d1", response: null },
        {
          documentId: "d2",
          response: {
            fileDocument: { ...doc, id: "d2", relativePath: "b.txt" },
            fileBuffer: textBuffer({ version: 2, content: "edited" }),
          },
        },
        {
          documentId: "d3",
          response: {
            fileDocument: { ...doc, id: "d3", relativePath: "c.txt" },
            fileBuffer: textBuffer({ version: 1 }),
          },
        },
      ],
    });
    expect(result.uncertainDocumentIds).toEqual(["d1"]);
    expect(result.buffers.d2.content).toBe("edited");
    expect(result.buffers.d3).toBe(buffers.d3);
    const impacts = collectAppExitImpacts({
      ptyCount: 0,
      documents,
      buffers: result.buffers,
      uncertainDocumentIds: result.uncertainDocumentIds,
    });
    expect(impacts.dirtyFiles.map((file) => file.documentId).sort()).toEqual([
      "d1",
      "d2",
    ]);
    expect(impacts.dirtyFiles.some((file) => file.documentId === "d3")).toBe(
      false,
    );
  });
});

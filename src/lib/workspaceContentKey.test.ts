import { describe, expect, it } from "vitest";
import {
  contentRefFromKey,
  fileContentKey,
  ptyContentKey,
  workspaceContentKey,
} from "./workspaceContentKey";

describe("workspace content identity key", () => {
  it("uses the same stable key for each managed content kind", () => {
    expect(workspaceContentKey({ kind: "pty", slotId: "slot-1" })).toBe(
      "pty:slot-1",
    );
    expect(workspaceContentKey({ kind: "file", documentId: "doc-1" })).toBe(
      "file:doc-1",
    );
  });

  it("keeps unknown kinds distinct while preserving their payload identity", () => {
    expect(
      workspaceContentKey({
        kind: "unknown",
        originalKind: "markdown",
        raw: { source: "a.md" },
      }),
    ).toBe('unknown:markdown:{"source":"a.md"}');
    expect(
      workspaceContentKey({
        kind: "unknown",
        originalKind: "markdown",
        raw: { source: "b.md" },
      }),
    ).not.toBe(
      workspaceContentKey({
        kind: "unknown",
        originalKind: "markdown",
        raw: { source: "a.md" },
      }),
    );

    expect(
      workspaceContentKey({
        kind: "unknown",
        originalKind: "markdown",
        raw: { nested: { second: 2, first: 1 }, source: "README.md" },
      }),
    ).toBe(
      workspaceContentKey({
        kind: "unknown",
        originalKind: "markdown",
        raw: { source: "README.md", nested: { first: 1, second: 2 } },
      }),
    );
  });
});

describe("draggable content keys", () => {
  it("ptyContentKey and fileContentKey equal workspaceContentKey of the same reference", () => {
    expect(ptyContentKey("s1")).toBe("pty:s1");
    expect(ptyContentKey("s1")).toBe(
      workspaceContentKey({ kind: "pty", slotId: "s1" }),
    );
    expect(fileContentKey("d1")).toBe("file:d1");
    expect(fileContentKey("d1")).toBe(
      workspaceContentKey({ kind: "file", documentId: "d1" }),
    );
  });

  it("contentRefFromKey inverts keys of draggable content", () => {
    expect(contentRefFromKey("pty:s1")).toEqual({ kind: "pty", slotId: "s1" });
    expect(contentRefFromKey("file:d1")).toEqual({
      kind: "file",
      documentId: "d1",
    });
    for (const key of ["pty:s1", "file:d:1"]) {
      expect(workspaceContentKey(contentRefFromKey(key)!)).toBe(key);
    }
  });

  it("contentRefFromKey rejects unknown content, garbage and oversized ids", () => {
    expect(
      contentRefFromKey(
        workspaceContentKey({ kind: "unknown", originalKind: "x", raw: {} }),
      ),
    ).toBeNull();
    expect(contentRefFromKey("")).toBeNull();
    expect(contentRefFromKey("pty:")).toBeNull();
    expect(contentRefFromKey("terminal:s1")).toBeNull();
    expect(contentRefFromKey("file")).toBeNull();
    expect(contentRefFromKey("pty:" + "a".repeat(201))).toBeNull();
    expect(contentRefFromKey("pty:" + "a".repeat(200))).not.toBeNull();
  });
});

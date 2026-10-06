import { describe, expect, it } from "vitest";
import { workspaceContentKey } from "./workspaceContentKey";

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

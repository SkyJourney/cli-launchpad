import { describe, expect, it } from "vitest";
import {
  contentRefFromKey,
  fileContentKey,
  fileContentRef,
  ptyContentKey,
  ptyContentRef,
  workspaceContentKey,
} from "./workspaceContentKey";

describe("content reference constructors", () => {
  it("builds the exact PTY and file reference shapes", () => {
    const pty = ptyContentRef("slot-1");
    const file = fileContentRef("doc-1");

    expect(pty).toEqual({ kind: "pty", slotId: "slot-1" });
    expect(Object.keys(pty)).toEqual(["kind", "slotId"]);
    expect(file).toEqual({ kind: "file", documentId: "doc-1" });
    expect(Object.keys(file)).toEqual(["kind", "documentId"]);
    expect(ptyContentRef("slot-1")).not.toBe(pty);
  });

  it("keeps the content keys and the inverse in step with the constructors", () => {
    expect(workspaceContentKey(ptyContentRef("slot-1"))).toBe("pty:slot-1");
    expect(workspaceContentKey(fileContentRef("doc-1"))).toBe("file:doc-1");
    expect(ptyContentKey("slot-1")).toBe(
      workspaceContentKey(ptyContentRef("slot-1")),
    );
    expect(fileContentKey("doc-1")).toBe(
      workspaceContentKey(fileContentRef("doc-1")),
    );
    expect(contentRefFromKey(ptyContentKey("slot-1"))).toEqual(
      ptyContentRef("slot-1"),
    );
    expect(contentRefFromKey(fileContentKey("doc-1"))).toEqual(
      fileContentRef("doc-1"),
    );
    expect(contentRefFromKey("unknown:future:{}")).toBeNull();
  });
});

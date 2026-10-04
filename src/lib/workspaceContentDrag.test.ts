import { describe, expect, it } from "vitest";
import {
  encodeWorkspaceContentDrag,
  parseWorkspaceContentDrag,
} from "./workspaceContentDrag";

describe("workspace content drag payload", () => {
  it.each(["pty", "file"] as const)(
    "preserves %s identity when moving between panes",
    (kind) => {
      const payload = {
        kind,
        contentId: "content-a",
        sourcePaneId: "pane-a",
        sourceWindowLabel: "main" as const,
      };
      expect(
        parseWorkspaceContentDrag(encodeWorkspaceContentDrag(payload)),
      ).toEqual(payload);
    },
  );

  it("preserves content kind when returning from an independent window", () => {
    const payload = {
      kind: "file" as const,
      contentId: "doc-a",
      sourceWindowLabel:
        "workspace-content-8e783338-f464-4b10-b15e-b534748c6241",
    };
    expect(
      parseWorkspaceContentDrag(encodeWorkspaceContentDrag(payload)),
    ).toEqual(payload);
  });

  it("rejects malformed, untrusted and oversized payloads", () => {
    expect(parseWorkspaceContentDrag("C:/secret.txt")).toBeNull();
    expect(parseWorkspaceContentDrag("x".repeat(1025))).toBeNull();
    expect(
      parseWorkspaceContentDrag(
        'cli-launchpad-content-v1:{"kind":"file","contentId":"doc","sourceWindowLabel":"main"}',
      ),
    ).toBeNull();
  });
});

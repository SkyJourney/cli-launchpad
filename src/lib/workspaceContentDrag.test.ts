import { describe, expect, it } from "vitest";
import { isDraggableContentKind } from "./windowKinds";
import {
  encodeWorkspaceContentDrag,
  parseWorkspaceContentDrag,
} from "./workspaceContentDrag";

describe("workspace content drag payload", () => {
  it.each(["pty", "file"] as const)(
    "preserves %s identity when moving between panes",
    (kind) => {
      const payload = {
        key: kind === "pty" ? "pty:content-a" : "file:content-a",
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
      key: "file:doc-a",
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
        'cli-launchpad-content-v2:{"key":"file:doc","sourceWindowLabel":"main"}',
      ),
    ).toBeNull();
  });

  it("rejects payloads in the previous format", () => {
    expect(
      parseWorkspaceContentDrag(
        'cli-launchpad-content-v1:{"kind":"file","contentId":"doc","sourcePaneId":"p","sourceWindowLabel":"main"}',
      ),
    ).toBeNull();
  });

  it("rejects keys that do not name draggable content", () => {
    expect(
      parseWorkspaceContentDrag(
        'cli-launchpad-content-v2:{"key":"unknown:x:{}","sourceWindowLabel":"main","sourcePaneId":"p"}',
      ),
    ).toBeNull();
    // 反向：合法的 key 被接受。
    expect(
      parseWorkspaceContentDrag(
        'cli-launchpad-content-v2:{"key":"pty:s1","sourceWindowLabel":"main","sourcePaneId":"p"}',
      ),
    ).toEqual({ key: "pty:s1", sourceWindowLabel: "main", sourcePaneId: "p" });
  });
});

describe("contract driven drag validation", () => {
  it("rejects a drag whose source window label is not a registered detached window", () => {
    const key = "pty:slot-1";
    const bad = [
      "terminal-not-a-uuid",
      "main",
      "terminal-8e783338-f464-0b10-b15e-b534748c6241",
      "settings",
    ];
    for (const sourceWindowLabel of bad) {
      expect(
        parseWorkspaceContentDrag(
          encodeWorkspaceContentDrag({ key, sourceWindowLabel } as never),
        ),
        sourceWindowLabel,
      ).toBeNull();
    }
    const good = "workspace-content-8e783338-f464-4b10-b15e-b534748c6241";
    expect(
      parseWorkspaceContentDrag(
        encodeWorkspaceContentDrag({ key, sourceWindowLabel: good }),
      ),
    ).toEqual({ key, sourceWindowLabel: good });
  });

  it("derives the draggable content kinds from the contract", () => {
    expect(isDraggableContentKind("pty")).toBe(true);
    expect(isDraggableContentKind("file")).toBe(true);
    expect(isDraggableContentKind("markdownPreview")).toBe(false);
  });
});

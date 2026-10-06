import { describe, expect, it } from "vitest";
import {
  createWindowLabel,
  isDetachedWindowLabel,
  windowKindOf,
} from "./windowKinds";

describe("window kind contract", () => {
  it("creates and classifies labels for each detached window kind", () => {
    const terminal = createWindowLabel("terminal");
    const workspaceContent = createWindowLabel("workspaceContent");

    expect(windowKindOf("main")).toBe("main");
    expect(windowKindOf(terminal)).toBe("terminal");
    expect(windowKindOf(workspaceContent)).toBe("workspaceContent");
    expect(isDetachedWindowLabel(terminal)).toBe(true);
    expect(isDetachedWindowLabel(workspaceContent)).toBe(true);
    expect(isDetachedWindowLabel("main")).toBe(false);
  });

  it.each([
    "terminal-not-a-uuid",
    "terminal-8e783338f4644b10b15eb534748c6241",
    "terminal-8e783338-f464-0b10-b15e-b534748c6241",
    "workspace-content-8e783338-f464-0b10-b15e-b534748c6241",
  ])("rejects noncanonical detached label %s", (label) => {
    expect(windowKindOf(label)).toBeNull();
    expect(isDetachedWindowLabel(label)).toBe(false);
  });
});

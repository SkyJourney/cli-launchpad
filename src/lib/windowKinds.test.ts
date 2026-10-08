import { describe, expect, it } from "vitest";
import fixtures from "../../contracts/window-label-fixtures.json";
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

  it("keeps the shared label fixtures well formed", () => {
    expect(Object.keys(fixtures.accept).sort()).toEqual([
      "main",
      "terminal",
      "workspaceContent",
    ]);
    for (const labels of Object.values(fixtures.accept)) {
      expect(labels.length).toBeGreaterThan(0);
    }
    expect(fixtures.reject.length).toBeGreaterThan(0);
    const accepted = new Set(Object.values(fixtures.accept).flat());
    for (const label of fixtures.reject) {
      expect(accepted.has(label)).toBe(false);
    }
  });

  it("classifies every shared accepted label with its registered kind", () => {
    for (const [kind, labels] of Object.entries(fixtures.accept)) {
      for (const label of labels) {
        expect(windowKindOf(label), label).toBe(kind);
        expect(isDetachedWindowLabel(label), label).toBe(kind !== "main");
      }
    }
  });

  it("rejects every shared rejected label", () => {
    for (const label of fixtures.reject) {
      expect(windowKindOf(label), JSON.stringify(label)).toBeNull();
      expect(isDetachedWindowLabel(label), JSON.stringify(label)).toBe(false);
    }
  });
});

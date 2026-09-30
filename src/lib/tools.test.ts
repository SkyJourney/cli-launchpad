import { describe, expect, it } from "vitest";
import { getTerminalTitleLabel, isManagedUpdateAllowed } from "./tools";

describe("terminal title CLI labels", () => {
  it.each([
    ["claude", "CC"],
    ["codex", "CDX"],
    ["antigravity", "AGY"],
    ["grok", "GB"],
  ] as const)("uses %s as %s", (toolKey, expectedLabel) => {
    expect(getTerminalTitleLabel(toolKey)).toBe(expectedLabel);
  });
});

describe("managed CLI updates", () => {
  it("requires a verified installer source for Grok Build", () => {
    expect(isManagedUpdateAllowed("grok", undefined)).toBe(false);
    expect(
      isManagedUpdateAllowed("grok", { managedUpdateAllowed: false }),
    ).toBe(false);
    expect(isManagedUpdateAllowed("grok", { managedUpdateAllowed: true })).toBe(
      true,
    );
  });

  it("keeps the existing update flow for the other CLIs", () => {
    expect(isManagedUpdateAllowed("claude", undefined)).toBe(true);
    expect(
      isManagedUpdateAllowed("codex", { managedUpdateAllowed: false }),
    ).toBe(true);
  });
});

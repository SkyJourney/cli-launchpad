import { describe, expect, it } from "vitest";
import { getTerminalTitleLabel } from "./tools";

describe("terminal title CLI labels", () => {
  it.each([
    ["claude", "CC"],
    ["codex", "CDX"],
    ["antigravity", "AGY"],
  ] as const)("uses %s as %s", (toolKey, expectedLabel) => {
    expect(getTerminalTitleLabel(toolKey)).toBe(expectedLabel);
  });
});

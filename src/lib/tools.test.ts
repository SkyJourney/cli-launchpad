import { describe, expect, it } from "vitest";
import managedUpdateFixture from "../../contracts/fixtures/managed-update-status.json";
import {
  getCliAdapter,
  getTerminalTitleLabel,
  getLatestUpdateAvailability,
  isManagedUpdateAllowed,
  TOOLS,
} from "./tools";

describe("CLI adapter registry", () => {
  it("keeps each built-in adapter registered once in product display order", () => {
    expect(TOOLS.map((tool) => tool.key)).toEqual([
      "claude",
      "codex",
      "antigravity",
      "grok",
      "hermes",
    ]);
    for (const tool of TOOLS) {
      expect(getCliAdapter(tool.key)).toBe(tool);
      expect(tool.label).toBeTruthy();
      expect(tool.shortLabel).toBeTruthy();
      expect(tool.icon).toBeTruthy();
    }
  });

  it("returns no adapter for an unknown runtime key", () => {
    expect(() => getCliAdapter("future-cli")).not.toThrow();
    expect(getCliAdapter("future-cli")).toBeUndefined();
  });
});

describe("terminal title CLI labels", () => {
  it.each([
    ["claude", "CC"],
    ["codex", "CDX"],
    ["antigravity", "AGY"],
    ["grok", "GB"],
    ["hermes", "HA"],
  ] as const)("uses %s as %s", (toolKey, expectedLabel) => {
    expect(getTerminalTitleLabel(toolKey)).toBe(expectedLabel);
  });
});

describe("managed CLI updates", () => {
  it("provides platform-appropriate installer effects", () => {
    expect(getCliAdapter("grok").installEffects?.("windows")).toBeDefined();
    expect(getCliAdapter("grok").installEffects?.("macos")).toBeDefined();
    expect(getCliAdapter("grok").installEffects?.("linux")).toBeDefined();
    expect(getCliAdapter("hermes").installEffects?.("windows")).toBeDefined();
    expect(getCliAdapter("hermes").installEffects?.("macos")).toBeDefined();
    expect(getCliAdapter("hermes").installEffects?.("linux")).toBeDefined();
  });

  it("renders update policy and availability directly from the backend DTO", () => {
    const fixtureValue = (name: string) =>
      managedUpdateFixture.cases.find((item) => item.name === name)!.value;
    const allowed = fixtureValue("allowed") as { status: "allowed" };
    const denied = fixtureValue("denied") as {
      status: "denied";
      reasonKey: string;
    };
    expect(isManagedUpdateAllowed(undefined)).toBe(false);
    expect(isManagedUpdateAllowed({ managedUpdate: allowed })).toBe(true);
    expect(isManagedUpdateAllowed({ managedUpdate: denied })).toBe(false);
    expect(getLatestUpdateAvailability(undefined)).toBe("unknown");
    expect(
      getLatestUpdateAvailability({
        updateAvailability: "upToDate",
      }),
    ).toBe("upToDate");
  });
});

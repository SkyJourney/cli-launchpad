import { describe, expect, it } from "vitest";
import { shouldQueryLatestVersion } from "./versionQueryPolicy";

describe("latest CLI version query policy", () => {
  it("waits until running execution tasks have been loaded", () => {
    expect(shouldQueryLatestVersion(true, false)).toBe(false);
  });

  it("skips the version query while a CLI execution task is active", () => {
    expect(shouldQueryLatestVersion(false, true)).toBe(false);
  });

  it("queries once tasks are loaded and the CLI is idle", () => {
    expect(shouldQueryLatestVersion(false, false)).toBe(true);
  });
});

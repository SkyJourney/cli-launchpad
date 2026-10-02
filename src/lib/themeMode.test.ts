import { describe, expect, it } from "vitest";
import { isThemeMode, resolveThemeMode } from "./themeMode";

describe("theme preference resolution", () => {
  it.each([
    ["light", false, "light"],
    ["light", true, "light"],
    ["dark", false, "dark"],
    ["dark", true, "dark"],
    ["system", false, "light"],
    ["system", true, "dark"],
  ] as const)(
    "resolves %s against system dark=%s",
    (mode, systemDark, expected) => {
      expect(resolveThemeMode(mode, systemDark)).toBe(expected);
    },
  );

  it("accepts only the registered theme preferences", () => {
    expect(isThemeMode("light")).toBe(true);
    expect(isThemeMode("dark")).toBe(true);
    expect(isThemeMode("system")).toBe(true);
    expect(isThemeMode("solarized")).toBe(false);
    expect(isThemeMode(null)).toBe(false);
  });
});

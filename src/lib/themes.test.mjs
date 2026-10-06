import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { THEMES, THEME_IDS } from "./themes.ts";

const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

function tokenBlock(themeId) {
  const selector =
    themeId === "light" ? ":root" : `:root[data-theme="${themeId}"]`;
  const selectorStart = styles.indexOf(selector);
  const blockStart = styles.indexOf("{", selectorStart);
  const blockEnd = styles.indexOf("\n}", blockStart);
  if (selectorStart < 0 || blockStart < 0 || blockEnd < 0) {
    throw new Error(`Missing CSS token block for theme ${themeId}`);
  }
  return styles.slice(blockStart + 1, blockEnd);
}

function declaredColorTokens(block) {
  return new Set(
    [...block.matchAll(/^\s*(--color-[\w-]+)\s*:/gm)].map((match) => match[1]),
  );
}

describe("theme registry", () => {
  it("has a complete semantic color token block for every registered theme", () => {
    const lightTokens = declaredColorTokens(tokenBlock("light"));
    expect(lightTokens.size).toBeGreaterThan(0);

    for (const themeId of THEME_IDS) {
      const actualTokens = declaredColorTokens(tokenBlock(themeId));
      expect([...actualTokens].sort()).toEqual([...lightTokens].sort());
    }
  });

  it("keeps terminal theme tokens complete and the same in light and dark modes", () => {
    const terminalTokens = [
      "--color-terminal-background",
      "--color-terminal-foreground",
      "--color-terminal-selection",
    ];
    for (const themeId of THEME_IDS) {
      const block = tokenBlock(themeId);
      for (const token of terminalTokens) {
        expect(block).toMatch(new RegExp(`^\\s*${token}:`, "m"));
      }
      expect(THEMES[themeId].terminal.ansi).toEqual(THEMES.light.terminal.ansi);
    }
  });
});

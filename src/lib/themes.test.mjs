import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { THEMES, THEME_IDS } from "./themes.ts";

const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

const THEME_BLOCK_PATTERN =
  /^:root(?:\[data-theme="[^"]+"\])?\s*\{[\s\S]*?^\}/gm;
const RAW_COLOR_PATTERN = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g;
// 白名单：只允许写“选择器 + 理由”。当前为空；新增条目必须逐项写明理由，不得放宽正则。
const RAW_COLOR_ALLOWLIST = [];

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

  it("keeps terminal theme tokens complete in every theme and the ANSI palette shared", () => {
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

  it("declares no raw colour literals outside theme token blocks", () => {
    const blocks = styles.match(THEME_BLOCK_PATTERN) ?? [];
    expect(blocks.length, "每个已注册主题恰有一个 token 块").toBe(
      THEME_IDS.length,
    );
    const outside = styles.replace(THEME_BLOCK_PATTERN, "");
    const hits = [...outside.matchAll(RAW_COLOR_PATTERN)].map(
      (match) => match[0],
    );
    expect(hits).toEqual(RAW_COLOR_ALLOWLIST);
  });

  it("terminal runtime does not follow theme changes", () => {
    // PD-07：终端始终使用深色调色板，登记为例外；若改选“提供浅色终端”，本用例随决策一并删除。
    const sources = [
      "../components/PtyTerminal.tsx",
      "./ptyTerminalRuntime.ts",
    ].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));
    for (const source of sources) {
      expect(source).not.toMatch(/MutationObserver/);
      expect(source).not.toMatch(/dataset\.theme/);
      expect(source).not.toMatch(/useResolvedTheme/);
      expect(source).not.toMatch(/subscribeResolvedTheme/);
    }
  });
});

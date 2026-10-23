import { afterEach, describe, expect, it } from "vitest";
import { ar } from "../i18n/locales/ar";
import { de } from "../i18n/locales/de";
import { en } from "../i18n/locales/en";
import es from "../i18n/locales/es.json";
import { fr } from "../i18n/locales/fr";
import { ja } from "../i18n/locales/ja";
import { ko } from "../i18n/locales/ko";
import { pt } from "../i18n/locales/pt";
import { ru } from "../i18n/locales/ru";
import { zh } from "../i18n/locales/zh";
import type { LocaleKey } from "../i18n/localeKeys";
import { listThemes, registerTheme } from "./themeRegistry";
import {
  getThemeDefinition,
  registerBuiltinThemes,
  resolveThemeMode,
  THEMES,
  type ThemeDefinition,
  type ThemeMode,
} from "./themes";

const LOCALES: Record<string, unknown> = {
  ar,
  de,
  en,
  es,
  fr,
  ja,
  ko,
  pt,
  ru,
  zh,
};

function lookup(locale: unknown, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (node, part) => (node as Record<string, unknown> | undefined)?.[part],
      locale,
    );
}

const disposers: Array<() => void> = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
});

describe("theme registry", () => {
  it("registers both built-in themes at module load with apiVersion 1", () => {
    expect(listThemes().map((theme) => theme.id)).toEqual(["light", "dark"]);
    for (const theme of listThemes()) {
      expect(theme.apiVersion).toBe(1);
    }
    expect(getThemeDefinition("dark")).toBe(THEMES.dark);
  });

  it("rejects a theme declaring an unsupported apiVersion and keeps the built-ins", () => {
    expect(() =>
      registerTheme({
        ...THEMES.dark,
        id: "test.old",
        apiVersion: 2 as never,
      }),
    ).toThrow("不支持主题 API 版本: 2");

    expect(listThemes()).toHaveLength(2);
    // Reverse: the rejected theme left nothing behind.
    expect(listThemes().map((theme) => theme.id)).not.toContain("test.old");
  });

  it("registerBuiltinThemes is idempotent and its cleanup never unregisters the built-ins", () => {
    expect(() => registerBuiltinThemes()).not.toThrow();
    const cleanup = registerBuiltinThemes();
    cleanup();

    // Reverse: the cleanup did not remove the built-ins.
    expect(listThemes().map((theme) => theme.id)).toEqual(["light", "dark"]);
  });

  it("resolves registered third-party themes through the registry", () => {
    const definition: ThemeDefinition = { ...THEMES.dark, id: "test.contrast" };
    const dispose = registerTheme(definition);
    disposers.push(dispose);

    expect(resolveThemeMode("test.contrast" as ThemeMode, false)).toEqual({
      id: "test.contrast",
      base: "dark",
    });
    expect(getThemeDefinition("test.contrast").monacoTheme).toBe("vs-dark");

    dispose();
    expect(() => getThemeDefinition("test.contrast")).toThrow(
      "未注册主题: test.contrast",
    );
    // Reverse: the system mode still resolves to a built-in.
    expect(resolveThemeMode("system", true)).toEqual({
      id: "dark",
      base: "dark",
    });
  });

  it("has a non-empty translation for every registered theme label key in all ten locales", () => {
    let checked = 0;
    for (const theme of listThemes()) {
      for (const [name, locale] of Object.entries(LOCALES)) {
        const value = lookup(locale, theme.labelKey);
        expect(typeof value, `${name}:${theme.labelKey}`).toBe("string");
        expect(value, `${name}:${theme.labelKey}`).not.toBe("");
        expect(value, `${name}:${theme.labelKey}`).not.toBe(theme.labelKey);
        checked += 1;
      }
    }
    // Reverse: the loop really ran.
    expect(checked).toBe(20);
  });
});

// Type-level check (TR-6): a key that is not in the English locale is rejected at compile time.
const validKey: LocaleKey = "theme.light";
// @ts-expect-error 不存在的 locale 键必须在编译期被拒绝
const invalidKey: LocaleKey = "theme.nonexistent";
void validKey;
void invalidKey;

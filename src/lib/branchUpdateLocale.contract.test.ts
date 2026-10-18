import { describe, expect, it } from "vitest";
import { projectSources } from "../test/sourceClosure";
import { LOCALES, lookupLocale } from "../test/locales";

const NEW_KEYS = [
  "settings.branchUpdateStatus",
  "settings.branchUpToDate",
  "settings.branchUpdateBehind",
  "settings.branchUpdateBehindUnknown",
  "settings.branchRefreshPrompt",
] as const;

const OLD_KEYS = [
  "settings.hermesUpdateStatus",
  "settings.hermesUpToDate",
  "settings.hermesUpdateBehind",
  "settings.hermesUpdateBehindUnknown",
  "settings.hermesRefreshPrompt",
] as const;

describe("generic branch update texts", () => {
  it("defines the generic branch update texts in all ten locales", () => {
    let checked = 0;
    for (const [name, locale] of Object.entries(LOCALES)) {
      for (const key of NEW_KEYS) {
        const value = lookupLocale(locale, key);
        expect(typeof value, `${name} ${key}`).toBe("string");
        expect((value as string).length, `${name} ${key}`).toBeGreaterThan(0);
        expect(value, `${name} ${key}`).not.toBe(key);
        checked += 1;
      }
    }
    expect(Object.keys(LOCALES)).toHaveLength(10);
    expect(checked).toBe(50);
  });

  it("does not hard-code a branch name and keeps the count placeholder only where needed", () => {
    for (const [name, locale] of Object.entries(LOCALES)) {
      for (const key of NEW_KEYS) {
        const value = lookupLocale(locale, key);
        expect(typeof value, `${name} ${key}`).toBe("string");
        expect(value as string, `${name} ${key}`).not.toMatch(/\bmain\b/i);
        const hasCount = (value as string).includes("{{count}}");
        expect(hasCount, `${name} ${key}`).toBe(
          key === "settings.branchUpdateBehind",
        );
      }
    }
  });

  it("removes the Hermes-specific keys and uses the generic ones in the settings view", () => {
    for (const [name, locale] of Object.entries(LOCALES)) {
      for (const key of OLD_KEYS) {
        expect(lookupLocale(locale, key), `${name} ${key}`).toBeUndefined();
      }
    }
    const source = projectSources["src/views/SettingsView.tsx"];
    expect(source, "找不到 SettingsView.tsx").toBeDefined();
    for (const key of NEW_KEYS) expect(source, key).toContain(key);
    for (const key of OLD_KEYS) expect(source, key).not.toContain(key);
  });
});

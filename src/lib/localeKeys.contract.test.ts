import { describe, expect, it } from "vitest";
import type { LocaleKey } from "../i18n/localeKeys";
import { LOCALES, lookupLocale } from "../test/locales";
import { TOOLS } from "./tools";

const PLATFORMS = ["windows", "macos", "linux"] as const;

describe("locale keys", () => {
  it("resolves every install effect key in all ten locales", () => {
    let notices = 0;
    for (const tool of TOOLS) {
      for (const platform of PLATFORMS) {
        const notice = tool.installEffects?.(platform);
        if (!notice) continue;
        notices += 1;
        for (const key of [notice.headingKey, ...notice.effectKeys]) {
          for (const [name, locale] of Object.entries(LOCALES)) {
            const value = lookupLocale(locale, key);
            expect(typeof value, `${tool.key} ${platform} ${name} ${key}`).toBe(
              "string",
            );
            expect((value as string).length).toBeGreaterThan(0);
          }
        }
      }
    }
    expect(notices).toBeGreaterThanOrEqual(6);
  });

  it("rejects keys that do not exist in the locale type", () => {
    const valid: LocaleKey = "settings.branchUpdateBehind";
    // @ts-expect-error 不存在的键必须被 LocaleKey 拒绝
    const invalid: LocaleKey = "settings.doesNotExist";
    expect([valid, invalid]).toHaveLength(2);
  });
});

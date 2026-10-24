import { describe, expect, it } from "vitest";
import toolKeys from "../../contracts/tool-keys.json";
import toolKeyFixtures from "../test/fixtures/tool-keys.json";
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
import {
  getProviderDescriptor,
  listProviderDescriptors,
} from "./toolCapabilities";
import { createToolAnchorRefs, getCliAdapter, TOOLS } from "./tools";

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
const PLATFORMS = ["windows", "macos", "linux"] as const;

function lookup(locale: unknown, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (node, part) => (node as Record<string, unknown> | undefined)?.[part],
      locale,
    );
}

describe("tool capability contract", () => {
  it("declares exactly the contract tool keys in display order", () => {
    const keys = listProviderDescriptors().map((item) => item.toolKey);

    // 测试构建的 Provider 清单 = 产品工具键 + 夹具工具键（夹具只存在于测试构建）。
    expect(keys).toEqual([...toolKeys.items, ...toolKeyFixtures.items]);
    expect(keys).toEqual(TOOLS.map((tool) => tool.key));
    expect(getProviderDescriptor("hermes").toolKey).toBe("hermes");
    expect(() => getProviderDescriptor("future-cli" as never)).toThrow(
      "未登记的 Provider 能力：future-cli",
    );
  });

  it("keeps frontend adapter metadata consistent with the capability contract", () => {
    for (const descriptor of listProviderDescriptors()) {
      const adapter = getCliAdapter(descriptor.toolKey);
      const effectsKey = descriptor.capabilities.installEffectsKey;
      expect(adapter.installEffects !== undefined).toBe(effectsKey !== null);
      if (effectsKey !== null) {
        for (const platform of PLATFORMS) {
          const notice = adapter.installEffects?.(platform);
          expect(notice?.headingKey.startsWith(`settings.${effectsKey}`)).toBe(
            true,
          );
          for (const key of notice?.effectKeys ?? []) {
            expect(key.startsWith(`settings.${effectsKey}`)).toBe(true);
          }
        }
      }
      expect("latestStatusKind" in adapter).toBe(false);
      expect(descriptor.capabilities.history).toBe(true);
      expect(descriptor.capabilities.resume).toBe(true);
    }
    const branchTools = listProviderDescriptors().filter(
      (item) => item.capabilities.updateSemantics === "branch",
    );
    expect(branchTools.map((item) => item.toolKey)).toEqual(["hermes"]);
  });

  it("has a translation for every denied update reason key in all ten locales", () => {
    let checked = 0;
    for (const descriptor of listProviderDescriptors()) {
      const policy = descriptor.capabilities.managedUpdate;
      if (policy.mode !== "sourceVerified") continue;
      for (const locale of Object.values(LOCALES)) {
        const value = lookup(locale, policy.deniedReasonKey);
        expect(typeof value === "string" && value.length > 0).toBe(true);
        expect(value).not.toBe(policy.deniedReasonKey);
        checked += 1;
      }
    }
    expect(checked).toBe(20);
  });

  it("derives the popover anchor refs from the registered tools", () => {
    const first = createToolAnchorRefs();
    const second = createToolAnchorRefs();

    expect(Object.keys(first).sort()).toEqual(
      TOOLS.map((tool) => tool.key).sort(),
    );
    for (const tool of TOOLS) {
      expect(first[tool.key].current).toBeNull();
      expect(first[tool.key]).not.toBe(second[tool.key]);
    }
  });
});

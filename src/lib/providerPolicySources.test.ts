import { describe, expect, it } from "vitest";

const sources = import.meta.glob("../**/*.{ts,tsx}", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

const productionSources = Object.entries(sources).filter(
  ([path]) =>
    !path.includes(".test.") &&
    !path.includes("/test/") &&
    !path.endsWith("providerPolicySources.test.ts"),
);

describe("provider policy sources", () => {
  it("does not hard-code one anchor ref per tool in the settings view", () => {
    const settings = sources["../views/SettingsView.tsx"];

    expect(settings, "找不到 SettingsView.tsx").toBeDefined();
    expect(settings).not.toMatch(
      /\b(claude|codex|antigravity|grok|hermes):\s*createRef/,
    );
    expect(settings).toMatch(/createToolAnchorRefs\(\)/);
  });

  it("keeps the update semantics only in the capability contract", () => {
    expect(productionSources.length).toBeGreaterThan(50);
    const offenders = productionSources
      .filter(
        ([, source]) =>
          source.includes("latestStatusKind") ||
          source.includes('"branch-update"'),
      )
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import baselineFile from "./effectTranslationBaseline.json";
import { scanSource, scanSources } from "../test/effectTranslationScan";

// 存量违规数量的上限：只减不增。基线来源与记录日期：m6-073 步骤 4（2026-10-18）。
const BASELINE_MAX = 3;

const baseline = baselineFile.items as Array<{ key: string; reason: string }>;

const rawSources = import.meta.glob("../**/*.{ts,tsx}", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

/** glob 的键相对本文件所在目录 src/lib；换算成 `src/...` 并排除测试、夹具与生成物。 */
const productionSources = Object.fromEntries(
  Object.entries(rawSources)
    .filter(
      ([key]) =>
        !/\.test\.(ts|tsx)$/.test(key) &&
        !key.includes("/test/") &&
        !key.includes("/generated/"),
    )
    .map(([key, value]) => [`src/${key.slice(3)}`, value]),
);

let cachedScan: ReturnType<typeof scanSources> | undefined;
const productionScan = () => (cachedScan ??= scanSources(productionSources));

const HEAD = `import { useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../i18n";
`;

describe("effect translation dependency scanner", () => {
  it("flags the translation function in effect dependencies", () => {
    const text = `${HEAD}
export function A() {
  const { t } = useTranslation();
  useEffect(() => { run(); }, [t]);
  return null;
}`;

    const violations = scanSource("src/A.tsx", text);

    expect(violations).toHaveLength(1);
    expect(violations[0].key).toBe("src/A.tsx::A::useEffect#1");
    expect(violations[0].problems[0]).toContain("依赖数组引用 t");
  });

  it("follows dependencies through useCallback and useMemo closures", () => {
    const text = `${HEAD}
export function B() {
  const { t } = useTranslation();
  const load = useCallback(() => { toast(t("x")); }, [t]);
  const memo = useMemo(() => load, [load]);
  useEffect(() => { memo(); }, [memo]);
  return null;
}`;

    const violations = scanSource("src/B.tsx", text);

    expect(violations).toHaveLength(1);
    expect(
      violations[0].problems.some((problem) =>
        problem.includes("→ memo → load"),
      ),
    ).toBe(true);
  });

  it("ignores module level i18n, shadowed t and functions that are not hooks", () => {
    const text = `${HEAD}
export function C({ list }: { list: string[] }) {
  const { t } = useTranslation();
  useEffect(() => { i18n.t("x"); }, []);
  useEffect(() => { list.forEach((t) => console.log(t)); }, [list]);
  const label = t("y");
  return label;
}
function plain(t: (k: string) => string) { return t("z"); }`;

    expect(scanSource("src/C.tsx", text)).toHaveLength(0);
  });

  it("accepts only a marked language sync effect keyed by resolvedLanguage", () => {
    const marked = `${HEAD}
export function D() {
  const { t, i18n: translation } = useTranslation();
  // R-FE-1:language-sync
  useEffect(() => { push(t("tray.show")); }, [translation.resolvedLanguage]);
  return null;
}`;

    expect(scanSource("src/D.tsx", marked)).toHaveLength(0);
    const withT = marked.replace(
      "[translation.resolvedLanguage]",
      "[translation.resolvedLanguage, t]",
    );
    expect(scanSource("src/D.tsx", withT)).toHaveLength(1);
    const unmarked = marked.replace("// R-FE-1:language-sync", "// nothing");
    expect(scanSource("src/D.tsx", unmarked)).toHaveLength(1);
    const wrongKey = marked.replace(
      "[translation.resolvedLanguage]",
      "[translation.language]",
    );
    expect(scanSource("src/D.tsx", wrongKey)).toHaveLength(1);
  });

  it("flags translation references inside effect callbacks", () => {
    const text = `${HEAD}
export function E() {
  const { t } = useTranslation();
  useEffect(() => { const handler = () => toast(t("x")); window.addEventListener("x", handler); }, []);
  return null;
}`;

    const violations = scanSource("src/E.tsx", text);

    expect(violations).toHaveLength(1);
    expect(violations[0].problems[0]).toContain("回调引用 t");
  });

  it("production code has no translation dependency outside the baseline", () => {
    const known = new Set(baseline.map((item) => item.key));
    const { violations } = productionScan();
    const fresh = violations.filter((violation) => !known.has(violation.key));
    const paste = JSON.stringify(
      {
        formatVersion: 1,
        items: violations
          .map((violation) => violation.key)
          .sort()
          .map((key) => ({
            key,
            reason:
              "存量（m6-073 基线）：语言切换会重新执行该 effect，待 R-FE-1 后续目标消除",
          })),
      },
      null,
      2,
    );

    expect(
      fresh.map((violation) => `${violation.key} — ${violation.problems[0]}`),
      `新增了依赖翻译函数的 effect：修复它，不得加入基线。全部当前违规（仅用于首次生成基线）：\n${paste}`,
    ).toEqual([]);
  }, 60_000);

  it("baseline contains only effects that still violate and never grows", () => {
    const { violations } = productionScan();
    const current = new Set(violations.map((violation) => violation.key));
    const keys = baseline.map((item) => item.key);

    expect(
      keys.filter((key) => !current.has(key)),
      "这些基线条目已不再违规：从基线里删除它们（只减不增），并把 BASELINE_MAX 改小",
    ).toEqual([]);
    expect(keys).toEqual([...keys].sort());
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBeLessThanOrEqual(BASELINE_MAX);
    for (const item of baseline) expect(item.reason.length).toBeGreaterThan(10);
  }, 60_000);

  it("scans enough production files and effects and includes the known components", () => {
    const { files, effects } = productionScan();

    expect(files).toBeGreaterThan(100);
    expect(effects).toBeGreaterThan(50);
    expect(Object.keys(productionSources)).toContain(
      "src/components/PtyWorkspace.tsx",
    );
    expect(Object.keys(productionSources)).toContain(
      "src/hooks/useThemeSync.ts",
    );
    expect(
      Object.keys(productionSources).some((file) => file.includes(".test.")),
    ).toBe(false);
    expect(
      Object.keys(productionSources).some((file) =>
        file.startsWith("src/test/"),
      ),
    ).toBe(false);
  }, 60_000);
});

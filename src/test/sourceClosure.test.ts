import { describe, expect, it } from "vitest";
import {
  computeImportClosure,
  importSpecifiers,
  isExcludedFromClosure,
  normalizeGlobKey,
  projectSources,
  resolveRelativeImport,
} from "./sourceClosure";

const fixture: Record<string, string> = {
  "src/a.ts":
    'import { b } from "./b"; const c = import("./dir/c"); import "./side"; import "react"; import "./style.css"; import raw from "../LICENSE?raw";',
  "src/b.ts": "export const b = 1;",
  "src/dir/c.tsx": 'import { d } from "../d"; import { e } from "../dir2";',
  "src/dir2/index.ts": "export const e = 1;",
  "src/d.ts": "export const d = 1;",
  "src/side.ts": "",
  "src/x.test.ts": 'import "./a";',
  "src/test/helper.ts": "",
  "src/stop.ts": 'import "./after";',
  "src/after.ts": "",
};

describe("sourceClosure", () => {
  it("resolves relative specifiers with .ts, .tsx and index suffixes", () => {
    expect(resolveRelativeImport("src/a.ts", "./b", fixture)).toBe("src/b.ts");
    expect(resolveRelativeImport("src/a.ts", "./dir/c", fixture)).toBe(
      "src/dir/c.tsx",
    );
    expect(resolveRelativeImport("src/dir/c.tsx", "../dir2", fixture)).toBe(
      "src/dir2/index.ts",
    );
    expect(resolveRelativeImport("src/dir/c.tsx", "../d", fixture)).toBe(
      "src/d.ts",
    );
    expect(resolveRelativeImport("src/a.ts", "./missing", fixture)).toBeNull();
  });

  it("follows static, dynamic and side-effect imports", () => {
    const closure = computeImportClosure(["src/a.ts"], fixture);

    expect(closure).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/d.ts",
      "src/dir/c.tsx",
      "src/dir2/index.ts",
      "src/side.ts",
    ]);
    expect(closure).not.toContain("src/x.test.ts");
    expect(closure).not.toContain("src/test/helper.ts");
    expect(closure).not.toContain("src/stop.ts");
  });

  it("ignores package imports and asset imports", () => {
    const closure = computeImportClosure(["src/a.ts"], fixture);
    const specifiers = importSpecifiers(fixture["src/a.ts"]);

    expect(specifiers).toContain("react");
    expect(specifiers).toContain("./style.css");
    expect(specifiers).toContain("../LICENSE?raw");
    for (const path of closure) {
      expect(path.startsWith("react")).toBe(false);
      expect(path.endsWith("style.css")).toBe(false);
      expect(path.includes("LICENSE")).toBe(false);
    }
  });

  it("throws unscanned source for an unresolvable code import and for a missing entry", () => {
    const withBroken = { ...fixture, "src/broken.ts": 'import "./nowhere";' };

    expect(() => computeImportClosure(["src/broken.ts"], withBroken)).toThrow(
      "unscanned source: src/broken.ts imports ./nowhere",
    );
    expect(() => computeImportClosure(["src/not-there.ts"], fixture)).toThrow(
      "unscanned source: entry src/not-there.ts",
    );
    expect(() => computeImportClosure(["src/a.ts"], fixture)).not.toThrow();
    expect(() =>
      computeImportClosure(["src/broken.ts"], {
        ...fixture,
        "src/broken.ts": 'import "./nowhere?foo";',
      }),
    ).toThrow("unscanned source: src/broken.ts imports ./nowhere?foo");
  });

  it("excludes test files and src/test modules", () => {
    expect(isExcludedFromClosure("src/x.test.ts")).toBe(true);
    expect(isExcludedFromClosure("src/y.test.tsx")).toBe(true);
    expect(isExcludedFromClosure("src/test/helper.ts")).toBe(true);
    expect(isExcludedFromClosure("src/testing.ts")).toBe(false);
    expect(isExcludedFromClosure("src/lib/test-utils.ts")).toBe(false);

    const closure = computeImportClosure(["src/a.ts"], {
      ...fixture,
      "src/b.ts": 'import "./x.test";',
    });
    expect(closure).not.toContain("src/x.test.ts");
  });

  it("stops at excluded modules without traversing their imports", () => {
    expect(computeImportClosure(["src/stop.ts"], fixture)).toContain(
      "src/after.ts",
    );
    expect(
      computeImportClosure(["src/stop.ts"], fixture, {
        stopAt: ["src/after.ts"],
      }),
    ).toEqual(["src/stop.ts"]);

    const stopped = computeImportClosure(["src/a.ts"], fixture, {
      stopAt: ["src/dir/c.tsx"],
    });
    expect(stopped).not.toContain("src/dir/c.tsx");
    expect(stopped).not.toContain("src/dir2/index.ts");
  });

  it("normalizes glob keys to src-relative paths for the real project sources", () => {
    expect(normalizeGlobKey("/src/lib/x.ts")).toBe("src/lib/x.ts");

    const keys = Object.keys(projectSources);
    expect(keys).toContain("src/main.tsx");
    expect(keys).toContain("src/lib/workspaceContentWindowProtocol.ts");
    expect(keys).toContain("src/lib/appPreferencesMain.ts");
    // 金丝雀：正则只认 import("字面量")；出现其他形态的动态 import（模板字符串、变量、
    // 第二参数）会在这里失败，提醒扫描器需要升级（AST 化属于 m6-073）。
    for (const [path, source] of Object.entries(projectSources)) {
      if (isExcludedFromClosure(path)) continue;
      const allDynamic = source.match(/\bimport\s*\(/g)?.length ?? 0;
      const literalDynamic =
        source.match(/\bimport\s*\(\s*["'][^"']+["']\s*\)/g)?.length ?? 0;
      expect({ path, unparsed: allDynamic - literalDynamic }).toEqual({
        path,
        unparsed: 0,
      });
    }
    for (const key of keys) {
      expect(key.startsWith("/")).toBe(false);
      expect(key.startsWith("../")).toBe(false);
      expect(key.startsWith("./")).toBe(false);
    }
  });
});

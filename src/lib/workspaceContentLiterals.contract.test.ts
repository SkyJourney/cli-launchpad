import { describe, expect, it } from "vitest";

// Matches `{ kind: "pty", slotId` and `{ kind: "file", documentId`, on one line
// or across lines, with a value or as a shorthand property.
const CONTENT_REF_LITERAL =
  /\{\s*kind:\s*"(pty|file)"\s*,\s*(slotId|documentId)\b/g;

// Root-absolute glob: keys are `/src/...`. A relative glob would give `./x.ts` for
// files in the test's own directory and silently skip them.
const rawSources = import.meta.glob("/src/**/*.{ts,tsx}", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

/** Drop tests, fixtures and generated files; keys become `src/...`. */
const productionSources = Object.fromEntries(
  Object.entries(rawSources)
    .filter(
      ([key]) =>
        !/\.test\.(ts|tsx)$/.test(key) &&
        !key.includes("/test/") &&
        !key.includes("/generated/"),
    )
    .map(([key, value]) => [key.slice(1), value]),
);

function countLiterals(text: string): number {
  return [...text.matchAll(CONTENT_REF_LITERAL)].length;
}

describe("content reference construction", () => {
  it("builds content references only through the constructors", () => {
    const perFile = Object.entries(productionSources)
      .map(([file, text]) => [file, countLiterals(text)] as const)
      .filter(([, count]) => count > 0);

    expect(Object.fromEntries(perFile)).toEqual({
      "src/lib/workspaceContentKey.ts": 2,
    });
  });

  it("detects single-line, multi-line and shorthand literals and ignores constructor calls", () => {
    const literals = [
      'const a = { kind: "pty", slotId: id };',
      'const b = {\n  kind: "file",\n  documentId: id,\n};',
      'ids.map((slotId) => ({ kind: "pty", slotId }));',
      'const c = { kind: "file", documentId } as const;',
    ];
    const calls = [
      "const a = ptyContentRef(id);",
      "const b = fileContentRef(id);",
      'type Ref = { kind: "pty"; slotId: string };',
    ];

    expect(literals.map(countLiterals)).toEqual([1, 1, 1, 1]);
    expect(calls.map(countLiterals)).toEqual([0, 0, 0]);
  });

  it("names slot ids slotId, never sessionId, in the pure layout module", () => {
    const layout = productionSources["src/lib/ptyWorkspaceLayout.ts"];

    expect(layout).toBeDefined();
    expect(layout.match(/\bsessionId\b/g) ?? []).toEqual([]);
  });

  it("scans enough production files and includes the known modules", () => {
    const files = Object.keys(productionSources);

    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain("src/lib/workspaceContentKey.ts");
    expect(files).toContain("src/lib/ptyWorkspaceLayout.ts");
    expect(files.some((file) => file.includes(".test."))).toBe(false);
    expect(files.some((file) => file.startsWith("src/test/"))).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import installPlanFixture from "../../contracts/fixtures/install-plan.json";
import { projectSources } from "../test/sourceClosure";

const PLAN_KEYS = [
  "args",
  "fingerprint",
  "kind",
  "preview",
  "program",
  "source",
  "toolKey",
];

describe("install plan shape", () => {
  it("has no effects field in the TypeScript type", () => {
    const source = projectSources["src/lib/tauri.ts"];
    expect(source, "找不到 src/lib/tauri.ts").toBeDefined();
    const start = source.indexOf("export interface InstallPlan {");
    expect(start).toBeGreaterThanOrEqual(0);
    const block = source.slice(start, source.indexOf("\n}", start));
    expect(block).toContain("fingerprint: string;");
    expect(block).not.toMatch(/\beffects\b/);
  });

  it("has no effects key in any Rust-generated fixture case", () => {
    const cases = (
      installPlanFixture as {
        cases: { name: string; value: Record<string, unknown> }[];
      }
    ).cases;
    expect(cases.length).toBeGreaterThan(0);
    for (const entry of cases) {
      expect(Object.keys(entry.value).sort(), entry.name).toEqual(PLAN_KEYS);
    }
  });
});

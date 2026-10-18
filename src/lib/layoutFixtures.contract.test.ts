import { describe, expect, it } from "vitest";
import { migrateWorkspaceLayoutDocument } from "./workspaceLayoutPersistence";

const valid = import.meta.glob(
  "../../contracts/fixtures/layouts/valid/*.json",
  {
    eager: true,
    query: "?raw",
    import: "default",
  },
) as Record<string, string>;
const invalid = import.meta.glob(
  "../../contracts/fixtures/layouts/invalid/*.json",
  {
    eager: true,
    query: "?raw",
    import: "default",
  },
) as Record<string, string>;

describe("shared layout fixtures", () => {
  it("accepts every valid layout document like the Rust validator does", () => {
    expect(Object.keys(valid).length).toBe(3);
    for (const [path, raw] of Object.entries(valid)) {
      expect(
        () => migrateWorkspaceLayoutDocument(JSON.parse(raw)),
        path,
      ).not.toThrow();
    }
  });

  it("rejects every invalid layout document like the Rust validator does", () => {
    expect(Object.keys(invalid).length).toBe(8);
    for (const [path, raw] of Object.entries(invalid)) {
      expect(
        () => migrateWorkspaceLayoutDocument(JSON.parse(raw)),
        path,
      ).toThrow();
    }
  });
});

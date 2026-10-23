import { describe, expect, it, vi } from "vitest";
import { UNKNOWN_PATH_SEMANTICS, type PathSemantics } from "./pathKey";
import { ProjectPathSemanticsRegistry } from "./projectPathSemantics";

const INSENSITIVE: PathSemantics = {
  case: "insensitive",
  normalizationInsensitive: "no",
};

describe("ProjectPathSemanticsRegistry", () => {
  it("returns unknown for an unloaded directory", () => {
    const registry = new ProjectPathSemanticsRegistry(vi.fn());
    expect(registry.get(1)).toEqual(UNKNOWN_PATH_SEMANTICS);
  });

  it("load is single-flight per directory", async () => {
    const fetch = vi.fn().mockResolvedValue(INSENSITIVE);
    const registry = new ProjectPathSemanticsRegistry(fetch);
    const [first, second] = await Promise.all([
      registry.load(1, "/p"),
      registry.load(1, "/p"),
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(first).toEqual(INSENSITIVE);
    expect(second).toEqual(INSENSITIVE);
    expect(registry.get(1)).toEqual(INSENSITIVE);
    // Another directory is its own flight.
    await registry.load(2, "/q");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("load failure returns unknown and is retried next time", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(INSENSITIVE);
    const registry = new ProjectPathSemanticsRegistry(fetch);
    expect(await registry.load(1, "/p")).toEqual(UNKNOWN_PATH_SEMANTICS);
    expect(registry.get(1)).toEqual(UNKNOWN_PATH_SEMANTICS);
    expect(await registry.load(1, "/p")).toEqual(INSENSITIVE);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(registry.get(1)).toEqual(INSENSITIVE);
  });

  it("clear forgets every directory", async () => {
    const registry = new ProjectPathSemanticsRegistry(
      vi.fn().mockResolvedValue(INSENSITIVE),
    );
    await registry.load(1, "/p");
    registry.clear();
    expect(registry.get(1)).toEqual(UNKNOWN_PATH_SEMANTICS);
  });

  it("never replaces a known answer with unknown", async () => {
    const registry = new ProjectPathSemanticsRegistry(vi.fn());
    registry.set(1, INSENSITIVE);
    registry.set(1, UNKNOWN_PATH_SEMANTICS);
    expect(registry.get(1)).toEqual(INSENSITIVE);
    // A known answer may be replaced by another known answer.
    const sensitive: PathSemantics = {
      case: "sensitive",
      normalizationInsensitive: "no",
    };
    registry.set(1, sensitive);
    expect(registry.get(1)).toEqual(sensitive);
  });
});

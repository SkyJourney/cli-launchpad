import { describe, expect, it, vi } from "vitest";
import { createRegistry, type RegistryItem } from "./createRegistry";

interface Item extends RegistryItem {
  kind: string;
}

function item(id: string, kind = id, apiVersion = 2): Item {
  return { id, kind, apiVersion };
}

function makeRegistry() {
  return createRegistry<Item>({
    name: "test",
    supportedApiVersions: [2],
    messages: {
      emptyId: "empty id",
      unsupportedApiVersion: (version) => `bad version ${version}`,
      duplicateId: (id) => `dup id ${id}`,
      duplicateKey: (key) => `dup key ${key}`,
    },
    keyOf: (candidate) => candidate.kind,
    validate: (candidate) => {
      if (candidate.kind === "invalid") throw new Error("validate failed");
    },
  });
}

describe("createRegistry", () => {
  it("registers, gets, lists in registration order and notifies subscribers once per change", () => {
    const registry = makeRegistry();
    const listener = vi.fn();
    registry.subscribe(listener);
    const a = item("a");
    const b = item("b");

    registry.register(a);
    registry.register(b);

    expect(registry.name).toBe("test");
    expect(registry.list().map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(registry.get("a")).toBe(a);
    expect(registry.getByKey("b")).toBe(b);
    expect(registry.get("missing")).toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("rejects an empty id, an unsupported version, a duplicate id and a duplicate key with the configured messages", () => {
    const registry = makeRegistry();
    const listener = vi.fn();
    registry.register(item("a"));
    registry.subscribe(listener);

    expect(() => registry.register(item(" "))).toThrow("empty id");
    expect(() => registry.register(item("x", "x", 1))).toThrow("bad version 1");
    expect(() => registry.register(item("a", "other"))).toThrow("dup id a");
    expect(() => registry.register(item("b", "a"))).toThrow("dup key a");

    expect(registry.list().map((entry) => entry.id)).toEqual(["a"]);
    expect(listener).not.toHaveBeenCalled();
  });

  it("unregisters only while the instance is still the registered one", () => {
    const registry = makeRegistry();
    const first = item("a");
    const unregisterFirst = registry.register(first);
    unregisterFirst();
    expect(registry.get("a")).toBeUndefined();
    expect(registry.getByKey("a")).toBeUndefined();

    const second = item("a");
    registry.register(second);
    unregisterFirst();

    expect(registry.get("a")).toBe(second);
  });

  it("runs the validate hook last and does not register a rejected item", () => {
    const registry = makeRegistry();
    registry.register(item("a"));

    expect(() => registry.register(item("x", "invalid"))).toThrow(
      "validate failed",
    );
    expect(() => registry.register(item("y", "invalid", 1))).toThrow(
      "bad version 1",
    );
    expect(() => registry.register(item("a", "invalid"))).toThrow("dup id a");
    expect(registry.list().map((entry) => entry.id)).toEqual(["a"]);
    expect(registry.getByKey("invalid")).toBeUndefined();
  });

  it("increments the revision once per successful register and per effective unregister", () => {
    const registry = makeRegistry();
    expect(registry.revision()).toBe(0);

    const unregister = registry.register(item("a"));
    expect(registry.revision()).toBe(1);
    expect(() => registry.register(item("a"))).toThrow();
    expect(registry.revision()).toBe(1);
    unregister();
    expect(registry.revision()).toBe(2);
    unregister();
    expect(registry.revision()).toBe(2);
  });

  it("returns a list snapshot that later registrations do not mutate", () => {
    const registry = makeRegistry();
    const before = registry.list();
    registry.register(item("z"));

    expect(before).toHaveLength(0);
    expect(registry.list()).toHaveLength(1);
  });

  it("uses the id as the secondary key when keyOf is not configured", () => {
    const registry = createRegistry<Item>({
      name: "nokey",
      supportedApiVersions: [2],
      messages: {
        emptyId: "e",
        unsupportedApiVersion: () => "v",
        duplicateId: (id) => `d ${id}`,
      },
    });
    const a = item("a", "k");
    registry.register(a);

    expect(registry.getByKey("a")).toBe(a);
    expect(registry.getByKey("k")).toBeUndefined();
    expect(() => registry.register(item("b", "a"))).not.toThrow();
  });
});

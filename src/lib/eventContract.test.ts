// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import events from "../../contracts/events.json";
import windowKinds from "../../contracts/window-kinds.json";
import { APP_PREFERENCES_EVENT } from "./appPreferences";
import { RUST_EVENTS } from "./eventNames";

const sources = import.meta.glob("../**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

// import.meta.glob keys are relative to this test file (src/lib).
const REGISTRY_FILES = [
  "./eventNames.ts",
  "./appPreferences.ts",
  "./workspaceContentWindowProtocol.ts",
];

describe("event contract", () => {
  it("lists the same Rust events as the TypeScript registry", () => {
    const rustEvents = events.items
      .filter((event) => event.allowedSourceKinds.includes("rust"))
      .map((event) => event.name)
      .sort();
    expect(Object.values(RUST_EVENTS).sort()).toEqual(rustEvents);
    expect(events.items.map((event) => event.name).sort()).toEqual(
      [...Object.values(RUST_EVENTS), APP_PREFERENCES_EVENT].sort(),
    );
  });

  it("never spells a contract event name outside the registry modules", () => {
    const names = events.items.map((event) => event.name);
    const offenders: string[] = [];
    for (const [path, source] of Object.entries(sources)) {
      if (REGISTRY_FILES.includes(path)) continue;
      if (/\.test\.tsx?$/.test(path) || path.includes("/test/")) continue;
      for (const name of names) {
        if (
          source.includes(`"${name}"`) ||
          source.includes(`'${name}'`) ||
          source.includes(`\`${name}\``)
        ) {
          offenders.push(`${path}: ${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
    expect(Object.keys(sources).length).toBeGreaterThan(50);
  });

  it("has well formed entries", () => {
    const kindIds = windowKinds.items.map((kind) => kind.id);
    const seen = new Set<string>();
    for (const event of events.items) {
      expect(seen.has(event.name), event.name).toBe(false);
      seen.add(event.name);
      expect(event.name).toMatch(/^[a-z]+(-[a-z]+)*$/);
      expect(["emit", "emit_to", "inbox", "relay"]).toContain(event.mechanism);
      expect(["rust-to-window", "window-to-window", "window-to-all"]).toContain(
        event.direction,
      );
      expect(["L1", "L2", "L3"]).toContain(event.plannedLayer);
      expect(
        event.payloadVersion === null || Number.isInteger(event.payloadVersion),
      ).toBe(true);
      for (const source of event.allowedSourceKinds) {
        expect(
          source === "rust" || kindIds.includes(source),
          `${event.name}: ${source}`,
        ).toBe(true);
      }
      expect(event.allowedTargetKinds.length, event.name).toBeGreaterThan(0);
      for (const target of event.allowedTargetKinds) {
        expect(kindIds, `${event.name}: ${target}`).toContain(target);
      }
    }
  });
});

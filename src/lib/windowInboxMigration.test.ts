// @vitest-environment node
import { describe, expect, it } from "vitest";

const sources = import.meta.glob("../**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function fileName(path: string) {
  return path.split("/").pop() ?? path;
}

describe("window inbox migration", () => {
  it("consumes Rust events only through the window inbox", () => {
    const production = Object.entries(sources).filter(
      ([path]) =>
        !path.includes(".test.") &&
        !path.includes("/test/") &&
        !path.endsWith("/eventNames.ts"),
    );
    expect(production.length).toBeGreaterThan(50);

    const consumers = production.filter(([, text]) =>
      text.includes("RUST_EVENTS."),
    );
    const violations = consumers
      .filter(([, text]) => /\blisten\s*[<(]/.test(text))
      .map(([path]) => path);

    expect(violations).toEqual([]);
    expect(consumers.map(([path]) => fileName(path)).sort()).toEqual(
      [
        "App.tsx",
        "WorkspaceDataRestoreListener.tsx",
        "protocolHandlers.file.ts",
        "protocolHandlers.pty.ts",
        "useExecutionTasks.ts",
        "windowMessages.ts",
      ].sort(),
    );
    expect(production.some(([, text]) => text.includes("onInboxEvent("))).toBe(
      true,
    );
  });
});

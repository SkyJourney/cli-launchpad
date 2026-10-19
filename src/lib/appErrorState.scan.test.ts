import { describe, expect, it } from "vitest";

/** A setter that stores a formatted string: the state must hold the structured error instead. */
const FORMATTED_STATE = /set[A-Za-z]*Error\(\s*formatAppError\(/;

// Keys are relative to this file (src/lib); test files are excluded.
const sources = import.meta.glob("../**/*.{ts,tsx}", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

describe("error state scan", () => {
  it("never stores a formatted error string in state", () => {
    const offenders = Object.entries(sources)
      .filter(([path]) => !/\.test\.tsx?$/.test(path))
      .flatMap(([path, text]) =>
        text
          .split("\n")
          .filter((line) => FORMATTED_STATE.test(line))
          .map((line) => `${path}: ${line.trim()}`),
      );
    expect(offenders).toEqual([]);

    // Reverse self-check: the pattern does catch a violating line.
    expect(FORMATTED_STATE.test("setError(formatAppError(reason, t));")).toBe(
      true,
    );
    expect(FORMATTED_STATE.test("setError(toAppErrorState(reason));")).toBe(
      false,
    );
  });
});

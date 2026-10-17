// @vitest-environment node
import { describe, expect, it } from "vitest";

const sources = import.meta.glob("../**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const production = Object.entries(sources).filter(
  ([path]) => !path.includes(".test.") && !path.includes("/test/"),
);

// Entries must be confirmed by the user; M7's renderer is decided in design gate M7-D7.
const HTML_SINK_ALLOWLIST: string[] = [];

describe("content security policy hygiene", () => {
  it("uses no dynamic code evaluation or raw HTML sinks", () => {
    const patterns = [
      /\beval\s*\(/,
      /\bnew\s+Function\s*\(/,
      /dangerouslySetInnerHTML/,
      /\.innerHTML\s*=[^=]/,
      /\.outerHTML\s*=[^=]/,
      /\binsertAdjacentHTML\s*\(/,
      /\bdocument\.write(?:ln)?\s*\(/,
    ];
    const violations = production
      .filter(([path]) => !HTML_SINK_ALLOWLIST.includes(path))
      .flatMap(([path, text]) =>
        patterns
          .filter((pattern) => pattern.test(text))
          .map((pattern) => `${path}: ${pattern}`),
      );

    expect(violations).toEqual([]);
    // Reverse: real sources were read and the allowlist stays empty.
    expect(production.length).toBeGreaterThan(50);
    expect(HTML_SINK_ALLOWLIST.length).toBe(0);
  });

  it("passes no strings to timers", () => {
    const violations = production
      .filter(([, text]) => /\bset(?:Timeout|Interval)\s*\(\s*["'`]/.test(text))
      .map(([path]) => path);

    expect(violations).toEqual([]);
    // Reverse: the scan sees real timer calls.
    expect(
      production.some(
        ([, text]) =>
          /\bsetTimeout\s*\(\s*\(/.test(text) ||
          /\bsetTimeout\s*\(\s*[A-Za-z_]/.test(text),
      ),
    ).toBe(true);
  });
});

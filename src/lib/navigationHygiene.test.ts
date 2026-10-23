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

// Entries must be confirmed by the user; M7's link handling is decided in the design gates.
const ANCHOR_ALLOWLIST: string[] = [];

describe("navigation hygiene", () => {
  it("uses no in-webview navigation primitives", () => {
    const patterns = [
      /\bwindow\.open\s*\(/,
      /\btarget\s*=\s*["']_blank["']/,
      /\blocation\.assign\s*\(/,
      /\blocation\.replace\s*\(/,
      /\blocation\.href\s*=[^=]/,
    ];
    const violations = production.flatMap(([path, text]) =>
      patterns
        .filter((pattern) => pattern.test(text))
        .map((pattern) => `${path}: ${pattern}`),
    );

    expect(violations).toEqual([]);
    // Reverse: real sources were read, and external links go through the opener.
    expect(production.length).toBeGreaterThan(50);
    const about = production.find(([path]) => path.endsWith("/AboutView.tsx"));
    expect(about?.[1]).toContain("openUrl(");
  });

  it("renders no anchors with an href outside the allowlist", () => {
    const violations = production
      .filter(([, text]) => /<a\s[^>]*\bhref\s*=/.test(text))
      .map(([path]) => path)
      .filter(
        (path) => !ANCHOR_ALLOWLIST.some((entry) => path.endsWith(entry)),
      );

    expect(violations).toEqual([]);
    expect(ANCHOR_ALLOWLIST.length).toBe(0);
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCurrentTheme } from "./themes";

const sources = import.meta.glob("../**/*.{ts,tsx}", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

function stubSystemDark(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockReturnValue({ matches }),
  });
}

afterEach(() => {
  delete (window as { matchMedia?: unknown }).matchMedia;
  window.localStorage.clear();
  vi.resetModules();
});

describe("resolveCurrentTheme", () => {
  it("follows the system preference only in system mode", () => {
    stubSystemDark(true);
    expect(resolveCurrentTheme("system").id).toBe("dark");
    expect(resolveCurrentTheme("light").id).toBe("light");
    expect(resolveCurrentTheme("dark").id).toBe("dark");

    stubSystemDark(false);
    expect(resolveCurrentTheme("system").id).toBe("light");
    expect(resolveCurrentTheme("dark").id).toBe("dark");
  });

  it("resolves the theme mode in exactly one production call site", () => {
    const production = Object.entries(sources).filter(
      ([key]) =>
        !/\.test\.(ts|tsx)$/.test(key) &&
        !key.includes("/test/") &&
        !key.includes("/generated/"),
    );
    expect(production.length).toBeGreaterThan(100);

    const callSites = production.flatMap(([key, text]) =>
      [...text.matchAll(/(?<!function\s)\bresolveThemeMode\(/g)].map(() => key),
    );

    // glob 键相对本文件所在目录 src/lib：同目录的 themes.ts 以 "./" 开头（与文档的偏差）。
    expect(callSites).toEqual(["./themes.ts"]);
  });

  it("derives the initial resolved theme of the store from the same function", async () => {
    window.localStorage.setItem("cli-launchpad.theme", "system");
    stubSystemDark(true);
    vi.resetModules();
    const dark = await import("../store/appStore");
    expect(dark.useAppStore.getState().resolvedTheme.id).toBe("dark");

    stubSystemDark(false);
    vi.resetModules();
    const light = await import("../store/appStore");
    expect(light.useAppStore.getState().resolvedTheme.id).toBe("light");
  });
});

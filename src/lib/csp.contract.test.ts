import { describe, expect, it } from "vitest";
import conf from "../../src-tauri/tauri.conf.json";
import macosConf from "../../src-tauri/tauri.macos.conf.json";
import offlineConf from "../../src-tauri/tauri.offline.conf.json";
import windowsConf from "../../src-tauri/tauri.windows.conf.json";

function parsePolicy(policy: string): Record<string, string[]> {
  const directives: Record<string, string[]> = {};
  for (const raw of policy.split(";")) {
    const text = raw.trim();
    if (!text) continue;
    const [name, ...values] = text.split(/\s+/);
    if (Object.prototype.hasOwnProperty.call(directives, name)) {
      throw new Error(`duplicate CSP directive: ${name}`);
    }
    directives[name] = values.sort();
  }
  return directives;
}

const production = parsePolicy(conf.app.security.csp);
const development = parsePolicy(conf.app.security.devCsp);

describe("content security policy", () => {
  it("defines the production directives exactly", () => {
    expect(production).toEqual({
      "default-src": ["'self'"],
      "script-src": ["'self'"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "img-src": ["'self'", "blob:", "data:"],
      "font-src": ["'self'", "data:"],
      "worker-src": ["'self'", "blob:"],
      "connect-src": ["'self'", "http://ipc.localhost", "ipc:"],
    });
    expect(Object.keys(production)).toHaveLength(7);
  });

  it("extends development only with Vite eval and dev server origins", () => {
    expect(development["script-src"]).toEqual(["'self'", "'unsafe-eval'"]);
    expect(development["script-src"]).toEqual(
      [...production["script-src"], "'unsafe-eval'"].sort(),
    );
    expect(development["connect-src"]).toEqual(
      [
        ...production["connect-src"],
        "http://localhost:1420",
        "ws://localhost:1420",
      ].sort(),
    );
    for (const name of Object.keys(production)) {
      if (name === "script-src" || name === "connect-src") continue;
      expect(development[name]).toEqual(production[name]);
    }
    expect(Object.keys(development).sort()).toEqual(
      Object.keys(production).sort(),
    );
  });

  it("never allows wildcards or unsafe-eval in production", () => {
    for (const value of Object.values(production).flat()) {
      expect(value).not.toBe("*");
      expect(value).not.toBe("'unsafe-eval'");
      expect(value).not.toBe("http:");
      expect(value).not.toBe("https:");
      // 生产策略合法地包含 http://ipc.localhost（Tauri IPC）；除它之外不得出现任何 localhost 值。
      if (value.includes("localhost")) {
        expect(value).toBe("http://ipc.localhost");
      }
      expect(value).not.toMatch(/^wss?:/);
      expect(value).not.toContain("127.0.0.1");
    }
  });

  it("does not override the policy in platform or offline overlays", () => {
    for (const overlay of [macosConf, windowsConf, offlineConf]) {
      expect(
        (overlay as { app?: { security?: unknown } }).app?.security,
      ).toBeUndefined();
    }
    expect(
      Object.prototype.hasOwnProperty.call(
        conf.app.security,
        "dangerousDisableAssetCspModification",
      ),
    ).toBe(false);
  });

  it("rejects duplicate directives in the policy parser", () => {
    expect(() => parsePolicy("script-src 'self'; script-src 'none'")).toThrow(
      "duplicate CSP directive: script-src",
    );
    expect(() =>
      parsePolicy("script-src 'self'; style-src 'self'"),
    ).not.toThrow();
  });
});

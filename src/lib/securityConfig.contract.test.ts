// @vitest-environment node
import { describe, expect, it } from "vitest";
import conf from "../../src-tauri/tauri.conf.json";
import macosConf from "../../src-tauri/tauri.macos.conf.json";
import offlineConf from "../../src-tauri/tauri.offline.conf.json";
import windowsConf from "../../src-tauri/tauri.windows.conf.json";
import defaultCapability from "../../src-tauri/capabilities/default.json";
import terminalCapability from "../../src-tauri/capabilities/terminal-window.json";
import contentCapability from "../../src-tauri/capabilities/workspace-content-window.json";

type LooseConfig = {
  app?: {
    withGlobalTauri?: boolean;
    security?: {
      csp?: string;
      dangerousDisableAssetCspModification?: boolean;
      assetProtocol?: { enable?: boolean };
    };
  };
};

describe("security configuration switches", () => {
  it("keeps the global Tauri object and the asset protocol disabled", () => {
    const base = conf as LooseConfig;
    expect([undefined, false]).toContain(base.app?.withGlobalTauri);
    expect([undefined, false]).toContain(
      base.app?.security?.dangerousDisableAssetCspModification,
    );
    expect(base.app?.security?.assetProtocol?.enable).not.toBe(true);
    for (const overlay of [macosConf, windowsConf, offlineConf]) {
      expect((overlay as LooseConfig).app?.withGlobalTauri).toBeUndefined();
      // Reverse: the overlay was really read.
      expect(Object.keys(overlay)).toContain("bundle");
    }
    // Reverse: the configuration was really read.
    expect(base.app?.security?.csp).toEqual(expect.any(String));
    expect(base.app?.security?.csp?.length).toBeGreaterThan(0);
  });

  it("defines no remote access in any capability", () => {
    const capabilities = [
      defaultCapability,
      terminalCapability,
      contentCapability,
    ] as Array<Record<string, unknown>>;
    for (const capability of capabilities) {
      expect(Object.keys(capability)).not.toContain("remote");
      expect(capability.windows).toEqual(expect.any(Array));
      expect((capability.windows as unknown[]).length).toBeGreaterThan(0);
    }
    // Reverse: these are the three capability files.
    expect(capabilities.map((capability) => capability.identifier)).toEqual([
      "default",
      "terminal-window",
      "workspace-content-window",
    ]);
  });
});

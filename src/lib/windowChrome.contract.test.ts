import { describe, expect, it } from "vitest";
import chromeContract from "../../contracts/window-chrome.json";
import macosConfig from "../../src-tauri/tauri.macos.conf.json";
import baseConfig from "../../src-tauri/tauri.conf.json";
import {
  getChildWindowChromeOptions,
  getWindowChromeOptions,
  getWindowChromePolicy,
} from "./windowChrome";

const UA = {
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  macos: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)",
  linux: "Mozilla/5.0 (X11; Linux x86_64)",
} as const;

describe("window chrome contract", () => {
  it("covers the three platforms and matches the macOS window configuration", () => {
    const platforms = chromeContract.items.map((item) => item.platform).sort();
    expect(platforms).toEqual(["linux", "macos", "windows"]);

    const macos = chromeContract.items.find(
      (item) => item.platform === "macos",
    );
    expect(macos?.trafficLightPosition).toEqual(
      macosConfig.app.windows[0].trafficLightPosition,
    );
    expect(macosConfig.app.windows[0].decorations).toBe(true);
    // 反向断言：基础配置（Windows、Linux）使用应用自绘标题栏。
    expect(baseConfig.app.windows[0].decorations).toBe(false);
    for (const item of chromeContract.items.filter(
      (entry) => entry.platform !== "macos",
    )) {
      expect(item.nativeControls).toBe(false);
      expect(item.trafficLightPosition).toBeNull();
    }
  });

  it("derives the window chrome policy from the contract", () => {
    for (const item of chromeContract.items) {
      const policy = getWindowChromePolicy(
        UA[item.platform as keyof typeof UA],
      );
      expect(policy).toEqual({
        platform: item.platform,
        hasNativeWindowControls: item.nativeControls,
        trafficLightInset: item.titlebarInset,
      });
    }
  });

  it("passes the contract traffic light position to child windows only on macOS", () => {
    const macos = getChildWindowChromeOptions(UA.macos);
    expect(macos).toMatchObject({
      decorations: true,
      titleBarStyle: "overlay",
      hiddenTitle: true,
      trafficLightPosition: { x: 14, y: 20 },
    });
    for (const platform of ["windows", "linux"] as const) {
      const options = getChildWindowChromeOptions(UA[platform]);
      expect(options).toEqual({ decorations: false });
      expect(options).not.toHaveProperty("trafficLightPosition");
    }
    // getWindowChromeOptions 的返回值保持不变（既有测试用 toEqual 断言它）。
    expect(getWindowChromeOptions(UA.macos)).toEqual({
      decorations: true,
      titleBarStyle: "overlay",
      hiddenTitle: true,
    });
  });
});

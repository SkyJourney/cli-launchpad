import { describe, expect, it } from "vitest";
import {
  getTerminalKeyIntent,
  getWindowChromeOptions,
  getWindowChromePolicy,
  isMacOSUserAgent,
} from "./windowChrome";

describe("window chrome platform policy", () => {
  it.each([
    {
      platform: "macOS",
      userAgent: "Macintosh; Intel Mac OS X 14_0",
      event: {
        key: "c",
        ctrlKey: false,
        altKey: false,
        metaKey: true,
        shiftKey: false,
      },
      expected: {
        copyText: true,
        pasteText: false,
        controlV: false,
        windowsAltV: false,
      },
    },
    {
      platform: "Windows",
      userAgent: "Windows NT 10.0; Win64; x64",
      event: {
        key: "v",
        ctrlKey: false,
        altKey: true,
        metaKey: false,
        shiftKey: false,
      },
      expected: {
        copyText: false,
        pasteText: false,
        controlV: false,
        windowsAltV: true,
      },
    },
    {
      platform: "Linux",
      userAgent: "X11; Linux x86_64",
      event: {
        key: "c",
        ctrlKey: true,
        altKey: false,
        metaKey: false,
        shiftKey: true,
      },
      expected: {
        copyText: true,
        pasteText: false,
        controlV: false,
        windowsAltV: false,
      },
    },
  ])(
    "maps terminal shortcuts for $platform in the platform policy",
    ({ userAgent, event, expected }) => {
      expect(getTerminalKeyIntent(event, userAgent)).toEqual(expected);
    },
  );

  it("keeps native macOS traffic lights and overlays the app titlebar", () => {
    const options = getWindowChromeOptions(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15",
    );

    expect(isMacOSUserAgent("Macintosh; Intel Mac OS X 14_0")).toBe(true);
    expect(options).toEqual({
      decorations: true,
      titleBarStyle: "overlay",
      hiddenTitle: true,
    });
    expect(getWindowChromePolicy("Macintosh; Mac OS X")).toEqual({
      platform: "macos",
      hasNativeWindowControls: true,
      trafficLightInset: 82,
    });
  });

  it.each([
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    "Mozilla/5.0 (X11; Linux x86_64)",
  ])("uses app-owned decorations outside macOS (%s)", (userAgent) => {
    expect(getWindowChromeOptions(userAgent)).toEqual({ decorations: false });
    expect(getWindowChromePolicy(userAgent).hasNativeWindowControls).toBe(
      false,
    );
  });
});

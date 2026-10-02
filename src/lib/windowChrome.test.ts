import { describe, expect, it } from "vitest";
import { getWindowChromeOptions, isMacOSUserAgent } from "./windowChrome";

describe("window chrome platform policy", () => {
  it("keeps native macOS traffic lights and overlays the app titlebar", () => {
    const options = getWindowChromeOptions(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15",
    );

    expect(isMacOSUserAgent("Macintosh; Intel Mac OS X 14_0")).toBe(true);
    expect(options).toEqual({
      decorations: true,
      titleBarStyle: "overlay",
      hiddenTitle: true,
      trafficLightPosition: { x: 14, y: 15 },
    });
  });

  it.each([
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    "Mozilla/5.0 (X11; Linux x86_64)",
  ])("uses app-owned decorations outside macOS (%s)", (userAgent) => {
    expect(getWindowChromeOptions(userAgent)).toEqual({ decorations: false });
  });
});

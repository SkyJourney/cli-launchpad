export interface WindowChromeOptions {
  decorations: boolean;
  titleBarStyle?: "overlay";
  hiddenTitle?: boolean;
  trafficLightPosition?: { x: number; y: number };
}

export function isMacOSUserAgent(userAgent: string): boolean {
  return /Macintosh|Mac OS X|MacPPC|MacIntel/i.test(userAgent);
}

export function getWindowChromeOptions(userAgent: string): WindowChromeOptions {
  if (isMacOSUserAgent(userAgent)) {
    return {
      decorations: true,
      titleBarStyle: "overlay",
      hiddenTitle: true,
      trafficLightPosition: { x: 14, y: 15 },
    };
  }

  return { decorations: false };
}

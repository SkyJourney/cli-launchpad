export interface WindowChromeOptions {
  decorations: boolean;
  titleBarStyle?: "overlay";
  hiddenTitle?: boolean;
}

export type WindowPlatform = "windows" | "macos" | "linux";

export interface WindowChromePolicy {
  platform: WindowPlatform;
  hasNativeWindowControls: boolean;
  trafficLightInset: number;
}

export interface TerminalKeyIntent {
  copyText: boolean;
  pasteText: boolean;
  controlV: boolean;
  windowsAltV: boolean;
}

type TerminalKeyEvent = Pick<
  KeyboardEvent,
  "key" | "ctrlKey" | "altKey" | "metaKey" | "shiftKey"
>;

export function isMacOSUserAgent(userAgent: string): boolean {
  return /Macintosh|Mac OS X|MacPPC|MacIntel/i.test(userAgent);
}

export function getWindowChromePolicy(userAgent: string): WindowChromePolicy {
  const platform = /Windows/i.test(userAgent)
    ? "windows"
    : isMacOSUserAgent(userAgent)
      ? "macos"
      : "linux";
  return {
    platform,
    hasNativeWindowControls: platform === "macos",
    trafficLightInset: platform === "macos" ? 82 : 0,
  };
}

export function getTerminalKeyIntent(
  event: TerminalKeyEvent,
  userAgent: string,
): TerminalKeyIntent {
  const { platform } = getWindowChromePolicy(userAgent);
  const key = event.key.toLowerCase();
  const control = event.ctrlKey && !event.altKey && !event.metaKey;
  const command = event.metaKey && !event.ctrlKey && !event.altKey;
  const isMac = platform === "macos";
  return {
    copyText: isMac
      ? command && !event.shiftKey && key === "c"
      : control && event.shiftKey && key === "c",
    pasteText: isMac
      ? command && !event.shiftKey && key === "v"
      : control && event.shiftKey && key === "v",
    controlV: control && !event.shiftKey && key === "v",
    windowsAltV:
      platform === "windows" &&
      event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      key === "v",
  };
}

export function getWindowChromeOptions(userAgent: string): WindowChromeOptions {
  if (getWindowChromePolicy(userAgent).hasNativeWindowControls) {
    return {
      decorations: true,
      titleBarStyle: "overlay",
      hiddenTitle: true,
    };
  }

  return { decorations: false };
}

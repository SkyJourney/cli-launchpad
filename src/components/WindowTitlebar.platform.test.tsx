// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const originalUserAgent = navigator.userAgent;

afterEach(() => {
  cleanup();
  Object.defineProperty(navigator, "userAgent", {
    value: originalUserAgent,
    configurable: true,
  });
  vi.resetModules();
});

describe("WindowTitlebar platform chrome", () => {
  it.each([
    ["Windows NT 10.0; Win64; x64", false],
    ["Macintosh; Intel Mac OS X 14_0", true],
    ["X11; Linux x86_64", false],
  ])("renders native-control policy for %s", async (ua, isMac) => {
    Object.defineProperty(navigator, "userAgent", {
      value: `Mozilla/5.0 (${ua})`,
      configurable: true,
    });
    vi.resetModules();
    const { WindowTitlebar } = await import("./WindowTitlebar");

    const { container } = render(<WindowTitlebar variant="main" />);

    const header = container.querySelector("header") as HTMLElement;
    expect(header.className.includes("window-titlebar-macos")).toBe(isMac);
    const names = [
      "windowChrome.minimize",
      "windowChrome.maximize",
      "windowChrome.close",
    ];
    for (const name of names) {
      expect(screen.queryByRole("button", { name }) !== null).toBe(!isMac);
    }
  });
});

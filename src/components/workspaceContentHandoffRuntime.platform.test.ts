// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { tauriMock } from "../test/tauriMock";
import { createWorkspaceContentWindow } from "./workspaceContentHandoffRuntime";

const originalUserAgent = navigator.userAgent;

afterEach(() => {
  Object.defineProperty(navigator, "userAgent", {
    value: originalUserAgent,
    configurable: true,
  });
});

describe("createWorkspaceContentWindow platform chrome", () => {
  it.each([
    ["Windows NT 10.0; Win64; x64", { decorations: false }],
    [
      "Macintosh; Intel Mac OS X 14_0",
      { decorations: true, titleBarStyle: "overlay", hiddenTitle: true },
    ],
    ["X11; Linux x86_64", { decorations: false }],
  ])("passes the platform window options for %s", (ua, expected) => {
    Object.defineProperty(navigator, "userAgent", {
      value: `Mozilla/5.0 (${ua})`,
      configurable: true,
    });

    createWorkspaceContentWindow({
      label: "terminal-8e783338-f464-4b10-b15e-b534748c6241",
      url: "/",
      title: "t",
    });

    const options = tauriMock.state.createdWindows[0].options as Record<
      string,
      unknown
    >;
    expect(options).toMatchObject({
      ...expected,
      dragDropEnabled: false,
      width: 1100,
    });
    if (!expected.decorations) {
      expect(options).not.toHaveProperty("titleBarStyle");
      expect(options).not.toHaveProperty("hiddenTitle");
    }
  });
});

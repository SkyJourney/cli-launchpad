// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tauriMock } from "../test/tauriMock";
import { useAppStore } from "../store/appStore";
import { applyRemoteAppLanguage } from "../i18n";
import {
  APP_PREFERENCES_EVENT,
  APP_PREFERENCES_REQUEST_EVENT,
  applyRemotePreferences,
  isAppPreferences,
} from "./appPreferences";
import { respondToAppPreferencesRequests } from "./appPreferencesMain";

describe("app preferences protocol", () => {
  beforeEach(async () => {
    useAppStore.getState().applyRemoteThemeMode("system");
    await applyRemoteAppLanguage("en");
    document.documentElement.dir = "ltr";
  });

  it("accepts only version 1 preferences with registered values", () => {
    expect(
      isAppPreferences({ apiVersion: 1, theme: "dark", language: "zh" }),
    ).toBe(true);
    expect(
      isAppPreferences({ apiVersion: 2, theme: "dark", language: "zh" }),
    ).toBe(false);
    expect(
      isAppPreferences({ apiVersion: 1, theme: "purple", language: "zh" }),
    ).toBe(false);
    expect(
      isAppPreferences({ apiVersion: 1, theme: "dark", language: "unknown" }),
    ).toBe(false);
  });

  it("applies remote preferences in memory without writing local storage", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    await applyRemotePreferences({
      apiVersion: 1,
      theme: "light",
      language: "ar",
    });

    expect(useAppStore.getState().themeMode).toBe("light");
    expect(document.documentElement.dir).toBe("rtl");
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });

  it.each([
    "terminal-8e783338-f464-4b10-b15e-b534748c6241",
    "workspace-content-8e783338-f464-4b10-b15e-b534748c6241",
  ])("answers a registered detached window request: %s", async (label) => {
    tauriMock.setCurrentWindowLabel("main");
    tauriMock.getWindow(label);
    await respondToAppPreferencesRequests(() => ({
      apiVersion: 1,
      theme: "dark",
      language: "ja",
    }));

    tauriMock.emitEvent(
      APP_PREFERENCES_REQUEST_EVENT,
      { apiVersion: 1, windowLabel: label },
      "main",
    );

    await vi.waitFor(() => {
      expect(tauriMock.state.emittedEvents).toContainEqual(
        expect.objectContaining({
          target: label,
          eventName: APP_PREFERENCES_EVENT,
          payload: { apiVersion: 1, theme: "dark", language: "ja" },
          windowLabel: "main",
        }),
      );
    });
  });

  it("does not answer a request for an unregistered label", async () => {
    tauriMock.setCurrentWindowLabel("main");
    const before = tauriMock.state.emittedEvents.length;
    await respondToAppPreferencesRequests(() => ({
      apiVersion: 1,
      theme: "dark",
      language: "en",
    }));
    tauriMock.emitEvent(
      APP_PREFERENCES_REQUEST_EVENT,
      { apiVersion: 1, windowLabel: "terminal-invalid" },
      "main",
    );

    await Promise.resolve();
    expect(tauriMock.state.emittedEvents).toHaveLength(before);
  });
});

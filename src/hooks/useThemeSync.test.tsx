// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyRemoteAppLanguage, setAppLanguage } from "../i18n";
import { APP_PREFERENCES_EVENT } from "../lib/appPreferences";
import { useAppStore } from "../store/appStore";
import { tauriMock } from "../test/tauriMock";
import { useThemeSync } from "./useThemeSync";

const preference = { apiVersion: 1, theme: "dark", language: "ar" } as const;

describe("useThemeSync", () => {
  beforeEach(async () => {
    useAppStore.getState().applyRemoteThemeMode("system");
    await applyRemoteAppLanguage("en");
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
  });

  it("updates the native tray labels when the main window language changes", async () => {
    tauriMock.setCurrentWindowLabel("main");
    renderHook(() => useThemeSync());

    await setAppLanguage("ar");

    await vi.waitFor(() => {
      expect(tauriMock.state.invokeCalls).toContainEqual({
        command: "set_tray_menu_labels",
        args: { show: "إظهار النافذة الرئيسية", quit: "إنهاء" },
      });
    });
  });

  it.each([
    "terminal-8e783338-f464-4b10-b15e-b534748c6241",
    "workspace-content-8e783338-f464-4b10-b15e-b534748c6241",
  ])("requests and applies initial preferences in %s", async (label) => {
    tauriMock.setCurrentWindowLabel(label);
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    renderHook(() => useThemeSync());

    await vi.waitFor(() => {
      expect(tauriMock.state.emittedEvents).toContainEqual({
        target: "main",
        eventName: "app-preferences-requested",
        payload: { apiVersion: 1, windowLabel: label },
      });
    });
    tauriMock.emitEvent(APP_PREFERENCES_EVENT, preference, label);

    await vi.waitFor(() => {
      expect(useAppStore.getState().themeMode).toBe("dark");
      expect(useAppStore.getState().resolvedTheme).toEqual({
        id: "dark",
        base: "dark",
      });
      expect(document.documentElement.dir).toBe("rtl");
    });
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });

  it("gets the latest preference when it changes during listener setup", async () => {
    const label = "terminal-8e783338-f464-4b10-b15e-b534748c6241";
    tauriMock.setCurrentWindowLabel(label);
    const windowMock = tauriMock.getWindow(label);
    let finishRegistration: ((unlisten: () => void) => void) | undefined;
    let pendingHandler: ((event: { payload: unknown }) => void) | undefined;
    (windowMock.listen as ReturnType<typeof vi.fn>).mockImplementation(
      (_eventName: string, handler: (event: { payload: unknown }) => void) =>
        new Promise((resolve) => {
          pendingHandler = handler;
          finishRegistration = resolve;
        }),
    );
    renderHook(() => useThemeSync());

    tauriMock.emitEvent(APP_PREFERENCES_EVENT, preference, label);
    expect(useAppStore.getState().themeMode).toBe("system");

    finishRegistration?.(vi.fn());
    await vi.waitFor(() =>
      expect(tauriMock.state.emittedEvents).toContainEqual({
        target: "main",
        eventName: "app-preferences-requested",
        payload: { apiVersion: 1, windowLabel: label },
      }),
    );
    pendingHandler?.({ payload: preference });

    await vi.waitFor(() => {
      expect(useAppStore.getState().themeMode).toBe("dark");
      expect(useAppStore.getState().resolvedTheme).toEqual({
        id: "dark",
        base: "dark",
      });
      expect(document.documentElement.dir).toBe("rtl");
    });
  });
});

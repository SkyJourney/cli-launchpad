// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyRemoteAppLanguage, setAppLanguage } from "../i18n";
import { APP_PREFERENCES_EVENT } from "../lib/appPreferences";
import { useAppStore } from "../store/appStore";
import { tauriMock } from "../test/tauriMock";
import { useThemeSync } from "./useThemeSync";
import { act } from "@testing-library/react";
import { toastSpy } from "../test/host/hostMocks";

vi.mock(
  "sonner",
  async () => (await import("../test/host/hostMocks")).sonnerMock,
);

const preference = { apiVersion: 1, theme: "dark", language: "ar" } as const;

describe("useThemeSync", () => {
  // 前一个用例挂载的 hook 若不卸载，会在后一个用例的子窗口 label 下被重新触发，
  // 以主窗口专用的方式调用 getByLabel（ACL 开启后表现为未处理的拒绝）。
  afterEach(() => {
    cleanup();
  });

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
      expect(tauriMock.state.invokeCalls).toContainEqual(
        expect.objectContaining({
          command: "set_tray_menu_labels",
          args: { show: "إظهار النافذة الرئيسية", quit: "إنهاء" },
          windowLabel: "main",
        }),
      );
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
      expect(tauriMock.state.emittedEvents).toContainEqual(
        expect.objectContaining({
          target: "main",
          eventName: "app-preferences-requested",
          payload: { apiVersion: 1, windowLabel: label },
          windowLabel: label,
        }),
      );
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
      expect(tauriMock.state.emittedEvents).toContainEqual(
        expect.objectContaining({
          target: "main",
          eventName: "app-preferences-requested",
          payload: { apiVersion: 1, windowLabel: label },
          windowLabel: label,
        }),
      ),
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

describe("useThemeSync diagnostics", () => {
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
    toastSpy.error.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("broadcasts theme changes from the main window", async () => {
    tauriMock.setCurrentWindowLabel("main");
    renderHook(() => useThemeSync());

    act(() => {
      useAppStore.getState().setThemeMode("dark");
    });

    await vi.waitFor(() => {
      expect(tauriMock.state.emittedEvents).toContainEqual(
        expect.objectContaining({
          target: null,
          eventName: "app-preferences",
          payload: expect.objectContaining({ theme: "dark" }),
        }),
      );
    });
  });

  it("applies a broadcast in a child without writing local storage", async () => {
    const label = "terminal-8e783338-f464-4b10-b15e-b534748c6241";
    tauriMock.setCurrentWindowLabel(label);
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    renderHook(() => useThemeSync());

    tauriMock.emitEvent(
      APP_PREFERENCES_EVENT,
      { apiVersion: 1, theme: "light", language: "en" },
      label,
    );

    await vi.waitFor(() => {
      expect(useAppStore.getState().themeMode).toBe("light");
    });
    expect(setItem).not.toHaveBeenCalled();
    // 反向断言：子窗口不得把偏好重新广播出去。
    expect(
      tauriMock.state.emittedEvents.filter(
        (event) => event.eventName === "app-preferences",
      ),
    ).toEqual([]);
    setItem.mockRestore();
  });

  it("surfaces a native theme sync failure in development", async () => {
    tauriMock.setCurrentWindowLabel("main");
    (
      tauriMock.getWindow("main").setTheme as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce({ code: "acl.denied", message: "x" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    renderHook(() => useThemeSync());

    act(() => {
      useAppStore.getState().setThemeMode("dark");
    });

    await vi.waitFor(() => {
      expect(toastSpy.error).toHaveBeenCalled();
    });
    expect(String(toastSpy.error.mock.calls[0]?.[0])).toContain(
      "window.theme_sync_failed",
    );
  });
});

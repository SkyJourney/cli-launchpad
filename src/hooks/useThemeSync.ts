import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useLayoutEffect } from "react";
import { type ThemeMode, useAppStore } from "../store/appStore";

const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";

export function useThemeSync() {
  const themeMode = useAppStore((state) => state.themeMode);
  const currentWindow = getCurrentWindow();

  useLayoutEffect(() => {
    const systemTheme = window.matchMedia(DARK_SCHEME_QUERY);

    const applyTheme = () => {
      const resolvedTheme =
        themeMode === "system"
          ? systemTheme.matches
            ? "dark"
            : "light"
          : themeMode;

      document.documentElement.dataset.theme = resolvedTheme;
      document.documentElement.style.colorScheme = resolvedTheme;
    };

    applyTheme();
    if (themeMode === "system") {
      systemTheme.addEventListener("change", applyTheme);
    }

    void getCurrentWindow()
      .setTheme(themeMode === "system" ? null : themeMode)
      .catch((error: unknown) => {
        console.error("Failed to sync the native window theme", error);
      });

    return () => {
      systemTheme.removeEventListener("change", applyTheme);
    };
  }, [themeMode]);

  useEffect(() => {
    if (currentWindow.label !== "main") return;

    void emit("theme-mode-changed", themeMode).catch((error: unknown) => {
      console.error("Failed to broadcast the application theme", error);
    });
  }, [currentWindow, themeMode]);

  useEffect(() => {
    if (currentWindow.label === "main") return;

    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<ThemeMode>("theme-mode-changed", (event) => {
      if (
        event.payload === "light" ||
        event.payload === "dark" ||
        event.payload === "system"
      ) {
        useAppStore.getState().setThemeMode(event.payload);
      }
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((error: unknown) => {
        console.error("Failed to listen for application theme changes", error);
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [currentWindow]);
}

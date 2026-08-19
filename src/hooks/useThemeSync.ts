import { getCurrentWindow } from "@tauri-apps/api/window";
import { useLayoutEffect } from "react";
import { useAppStore } from "../store/appStore";

const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";

export function useThemeSync() {
  const themeMode = useAppStore((state) => state.themeMode);

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
}

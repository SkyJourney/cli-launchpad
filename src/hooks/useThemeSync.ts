import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useEffect, useLayoutEffect } from "react";
import { isThemeMode, resolveThemeMode } from "../lib/themeMode";
import { useAppStore } from "../store/appStore";

const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";

export function useThemeSync() {
  const themeMode = useAppStore((state) => state.themeMode);
  const currentWindowLabel = getCurrentWindow().label;

  useLayoutEffect(() => {
    const systemTheme = window.matchMedia(DARK_SCHEME_QUERY);

    const applyTheme = () => {
      const resolvedTheme = resolveThemeMode(themeMode, systemTheme.matches);

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
    if (currentWindowLabel !== "main") return;

    void emit("theme-mode-changed", themeMode).catch((error: unknown) => {
      console.error("Failed to broadcast the application theme", error);
    });
  }, [currentWindowLabel, themeMode]);

  useEffect(() => {
    if (currentWindowLabel !== "main") {
      let disposed = false;
      let unlisten: (() => void) | undefined;
      void listen<unknown>("theme-mode-changed", (event) => {
        if (isThemeMode(event.payload)) {
          useAppStore.getState().setThemeMode(event.payload);
        }
      })
        .then((stop) => {
          if (disposed) {
            stop();
            return;
          }
          unlisten = stop;
          return emitTo("main", "theme-mode-requested", currentWindowLabel);
        })
        .catch((error: unknown) => {
          console.error(
            "Failed to synchronize the detached window theme",
            error,
          );
        });

      return () => {
        disposed = true;
        unlisten?.();
      };
    }

    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<unknown>("theme-mode-requested", (event) => {
      const targetLabel = event.payload;
      if (
        typeof targetLabel !== "string" ||
        !/^terminal-[\da-f-]+$/i.test(targetLabel)
      ) {
        return;
      }
      void WebviewWindow.getByLabel(targetLabel)
        .then((targetWindow) => {
          if (!disposed && targetWindow) {
            return emitTo(
              targetLabel,
              "theme-mode-changed",
              useAppStore.getState().themeMode,
            );
          }
          return undefined;
        })
        .catch((error: unknown) => {
          console.error(
            "Failed to reply to the detached window theme request",
            error,
          );
        });
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((error: unknown) => {
        console.error(
          "Failed to listen for detached window theme requests",
          error,
        );
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [currentWindowLabel]);
}

import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useLayoutEffect } from "react";
import { useTranslation } from "react-i18next";
import { getAppLanguage } from "../i18n";
import {
  applyRemotePreferences,
  currentAppPreferences,
} from "../lib/appPreferences";
import {
  listenForAppPreferences,
  requestInitialAppPreferences,
} from "../lib/appPreferencesChild";
import {
  publishAppPreferences,
  respondToAppPreferencesRequests,
} from "../lib/appPreferencesMain";
import { resolveThemeMode } from "../lib/themeMode";
import { useAppStore } from "../store/appStore";

const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";

function reportWindowSyncFailure(code: string, error: unknown) {
  console.warn(`[${code}] 原生窗口偏好同步失败`, error);
}

export function useThemeSync() {
  const themeMode = useAppStore((state) => state.themeMode);
  const { i18n: translation } = useTranslation();
  const currentWindowLabel = getCurrentWindow().label;
  const language = getAppLanguage();

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
      .catch((error: unknown) =>
        reportWindowSyncFailure("window.theme_sync_failed", error),
      );

    return () => {
      systemTheme.removeEventListener("change", applyTheme);
    };
  }, [themeMode]);

  useEffect(() => {
    if (currentWindowLabel === "main") {
      let disposed = false;
      let unlistenRequest: (() => void) | undefined;
      void respondToAppPreferencesRequests(() =>
        currentAppPreferences(useAppStore.getState().themeMode),
      )
        .then((stop) => {
          if (disposed) stop();
          else unlistenRequest = stop;
        })
        .catch((error: unknown) =>
          reportWindowSyncFailure(
            "window.preferences_request_listener_failed",
            error,
          ),
        );

      return () => {
        disposed = true;
        unlistenRequest?.();
      };
    }

    let disposed = false;
    let unlistenPreferences: (() => void) | undefined;
    void listenForAppPreferences((preferences) => {
      void applyRemotePreferences(preferences).catch((error: unknown) =>
        reportWindowSyncFailure("window.preferences_apply_failed", error),
      );
    })
      .then((stop) => {
        if (disposed) {
          stop();
          return;
        }
        unlistenPreferences = stop;
        return requestInitialAppPreferences(currentWindowLabel);
      })
      .catch((error: unknown) =>
        reportWindowSyncFailure("window.preferences_listen_failed", error),
      );

    return () => {
      disposed = true;
      unlistenPreferences?.();
    };
  }, [currentWindowLabel]);

  useEffect(() => {
    if (currentWindowLabel !== "main") return;
    void publishAppPreferences(currentAppPreferences(themeMode)).catch(
      (error: unknown) =>
        reportWindowSyncFailure("window.preferences_publish_failed", error),
    );
  }, [currentWindowLabel, themeMode, language, translation.language]);
}

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
import { getThemeDefinition, resolveThemeMode } from "../lib/themes";
import { setTrayMenuLabels } from "../lib/tauri";
import { reportWindowSyncFailure } from "../lib/windowSyncDiagnostics";
import { useAppStore } from "../store/appStore";

const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";

export function useThemeSync() {
  const themeMode = useAppStore((state) => state.themeMode);
  const { i18n: translation, t } = useTranslation();
  const currentWindowLabel = getCurrentWindow().label;
  const language = getAppLanguage();

  useLayoutEffect(() => {
    const systemTheme = window.matchMedia(DARK_SCHEME_QUERY);

    const applyTheme = () => {
      const resolvedTheme = resolveThemeMode(themeMode, systemTheme.matches);
      useAppStore.getState().setResolvedTheme(resolvedTheme);
      document.documentElement.dataset.theme = resolvedTheme.id;
      document.documentElement.style.colorScheme = resolvedTheme.base;
    };

    applyTheme();
    if (themeMode === "system") {
      systemTheme.addEventListener("change", applyTheme);
    }

    const nativeTheme =
      themeMode === "system" ? null : getThemeDefinition(themeMode).base;
    void getCurrentWindow()
      .setTheme(nativeTheme)
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
    let replyUnavailable = false;
    let unlistenPreferences: (() => void) | undefined;
    void listenForAppPreferences(
      (preferences) => {
        void applyRemotePreferences(preferences).catch((error: unknown) =>
          reportWindowSyncFailure("window.preferences_apply_failed", error),
        );
      },
      (path, error) => {
        // The other path keeps working; without the reply path the initial request would never
        // be answered, so it is skipped below.
        if (path === "reply") replyUnavailable = true;
        reportWindowSyncFailure("window.preferences_listen_failed", error);
      },
    )
      .then((stop) => {
        if (disposed) {
          stop();
          return;
        }
        unlistenPreferences = stop;
        if (replyUnavailable) return;
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
    void setTrayMenuLabels({
      show: t("tray.show"),
      quit: t("tray.quit"),
    }).catch((error: unknown) =>
      reportWindowSyncFailure("window.tray_menu_sync_failed", error),
    );
    void publishAppPreferences(currentAppPreferences(themeMode)).catch(
      (error: unknown) =>
        reportWindowSyncFailure("window.preferences_publish_failed", error),
    );
  }, [currentWindowLabel, themeMode, language, t, translation.language]);
}

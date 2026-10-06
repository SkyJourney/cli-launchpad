import {
  applyRemoteAppLanguage,
  getAppLanguage,
  isAppLanguage,
  type AppLanguage,
} from "../i18n";
import { isThemeMode, type ThemeMode } from "./themeMode";
import { useAppStore } from "../store/appStore";

export const APP_PREFERENCES_EVENT = "app-preferences";
export const APP_PREFERENCES_REQUEST_EVENT = "app-preferences-requested";
export const APP_PREFERENCES_API_VERSION = 1 as const;

export interface AppPreferences {
  apiVersion: typeof APP_PREFERENCES_API_VERSION;
  theme: ThemeMode;
  language: AppLanguage;
}

export interface AppPreferencesRequest {
  apiVersion: typeof APP_PREFERENCES_API_VERSION;
  windowLabel: string;
}

export function isAppPreferences(value: unknown): value is AppPreferences {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).apiVersion ===
      APP_PREFERENCES_API_VERSION &&
    isThemeMode((value as Record<string, unknown>).theme) &&
    isAppLanguage((value as Record<string, unknown>).language)
  );
}

export function currentAppPreferences(theme: ThemeMode): AppPreferences {
  return {
    apiVersion: APP_PREFERENCES_API_VERSION,
    theme,
    language: getAppLanguage(),
  };
}

export async function applyRemotePreferences(preferences: AppPreferences) {
  useAppStore.getState().applyRemoteThemeMode(preferences.theme);
  await applyRemoteAppLanguage(preferences.language);
}

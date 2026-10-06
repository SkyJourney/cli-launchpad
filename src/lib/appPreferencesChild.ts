import { emitTo, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  APP_PREFERENCES_API_VERSION,
  APP_PREFERENCES_EVENT,
  APP_PREFERENCES_REQUEST_EVENT,
  isAppPreferences,
  type AppPreferences,
  type AppPreferencesRequest,
} from "./appPreferences";

export async function listenForAppPreferences(
  onPreferences: (preferences: AppPreferences) => void,
): Promise<UnlistenFn> {
  return getCurrentWebviewWindow().listen<unknown>(
    APP_PREFERENCES_EVENT,
    ({ payload }) => {
      if (isAppPreferences(payload)) onPreferences(payload);
    },
  );
}

export async function requestInitialAppPreferences(windowLabel: string) {
  const request: AppPreferencesRequest = {
    apiVersion: APP_PREFERENCES_API_VERSION,
    windowLabel,
  };
  await emitTo("main", APP_PREFERENCES_REQUEST_EVENT, request);
}

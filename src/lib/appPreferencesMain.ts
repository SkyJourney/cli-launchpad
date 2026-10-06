import { emit, emitTo, type UnlistenFn } from "@tauri-apps/api/event";
import {
  getCurrentWebviewWindow,
  WebviewWindow,
} from "@tauri-apps/api/webviewWindow";
import {
  APP_PREFERENCES_API_VERSION,
  APP_PREFERENCES_EVENT,
  APP_PREFERENCES_REQUEST_EVENT,
  type AppPreferences,
} from "./appPreferences";
import { isDetachedWindowLabel } from "./windowKinds";

export async function publishAppPreferences(preferences: AppPreferences) {
  await emit(APP_PREFERENCES_EVENT, preferences);
}

export async function respondToAppPreferencesRequests(
  getPreferences: () => AppPreferences,
): Promise<UnlistenFn> {
  return getCurrentWebviewWindow().listen<unknown>(
    APP_PREFERENCES_REQUEST_EVENT,
    async ({ payload }) => {
      if (
        typeof payload !== "object" ||
        payload === null ||
        Array.isArray(payload)
      ) {
        return;
      }
      const request = payload as Record<string, unknown>;
      if (
        request.apiVersion !== APP_PREFERENCES_API_VERSION ||
        typeof request.windowLabel !== "string" ||
        !isDetachedWindowLabel(request.windowLabel)
      ) {
        return;
      }
      const target = await WebviewWindow.getByLabel(request.windowLabel);
      if (!target) return;
      await emitTo(
        request.windowLabel,
        APP_PREFERENCES_EVENT,
        getPreferences(),
      );
    },
  );
}

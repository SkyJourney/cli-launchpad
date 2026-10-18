import { emit } from "@tauri-apps/api/event";
import {
  APP_PREFERENCES_API_VERSION,
  APP_PREFERENCES_EVENT,
  APP_PREFERENCES_REPLY_MESSAGE,
  APP_PREFERENCES_REQUEST_MESSAGE,
  type AppPreferences,
} from "./appPreferences";
import type { Unlisten } from "./windowInbox";
import { onWindowMessage, sendWindowMessage } from "./windowMessages";

export async function publishAppPreferences(preferences: AppPreferences) {
  await emit(APP_PREFERENCES_EVENT, preferences);
}

/**
 * Answers the preferences requests of child windows through the relay. A request is answered only
 * when the label it claims is the label Rust stamped on it, and the reply goes to that window.
 */
export async function respondToAppPreferencesRequests(
  getPreferences: () => AppPreferences,
): Promise<Unlisten> {
  return onWindowMessage<unknown>(
    APP_PREFERENCES_REQUEST_MESSAGE,
    async ({ payload, source }) => {
      if (
        typeof payload !== "object" ||
        payload === null ||
        Array.isArray(payload)
      ) {
        return;
      }
      const request = payload as Record<string, unknown>;
      if (request.apiVersion !== APP_PREFERENCES_API_VERSION) {
        console.warn(
          `[protocol.version_mismatch] ${APP_PREFERENCES_REQUEST_MESSAGE}: 期望 ${APP_PREFERENCES_API_VERSION}，收到 ${String(request.apiVersion)}`,
        );
        return;
      }
      if (
        typeof request.windowLabel !== "string" ||
        request.windowLabel !== source.label
      ) {
        return;
      }
      await sendWindowMessage(
        source.label,
        APP_PREFERENCES_REPLY_MESSAGE,
        getPreferences(),
      );
    },
  );
}

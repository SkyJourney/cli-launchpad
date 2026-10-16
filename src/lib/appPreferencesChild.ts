import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  APP_PREFERENCES_API_VERSION,
  APP_PREFERENCES_EVENT,
  APP_PREFERENCES_REPLY_MESSAGE,
  APP_PREFERENCES_REQUEST_MESSAGE,
  isAppPreferences,
  type AppPreferences,
  type AppPreferencesRequest,
} from "./appPreferences";
import { onWindowMessage, sendWindowMessage } from "./windowMessages";

/**
 * Preferences reach a child window two ways: the main window's public broadcast and the reply to
 * its own request (a relayed message from the main window). Both must register.
 */
export async function listenForAppPreferences(
  onPreferences: (preferences: AppPreferences) => void,
): Promise<UnlistenFn> {
  const results = await Promise.allSettled([
    getCurrentWebviewWindow().listen<unknown>(
      APP_PREFERENCES_EVENT,
      ({ payload }) => {
        if (isAppPreferences(payload)) onPreferences(payload);
      },
    ),
    onWindowMessage<unknown>(APP_PREFERENCES_REPLY_MESSAGE, ({ payload }) => {
      if (isAppPreferences(payload)) onPreferences(payload);
    }),
  ]);
  const stops = results.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  const failed = results.find((result) => result.status === "rejected");
  if (failed && failed.status === "rejected") {
    for (const stop of stops) stop();
    throw failed.reason;
  }
  return () => {
    for (const stop of stops) stop();
  };
}

export async function requestInitialAppPreferences(windowLabel: string) {
  const request: AppPreferencesRequest = {
    apiVersion: APP_PREFERENCES_API_VERSION,
    windowLabel,
  };
  await sendWindowMessage("main", APP_PREFERENCES_REQUEST_MESSAGE, request);
}

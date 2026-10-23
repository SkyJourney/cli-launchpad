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
import { MAIN_WINDOW_LABEL } from "./windowKinds";

/**
 * Preferences reach a child window two ways: the main window's public broadcast and the reply to
 * its own request (a relayed message from the main window). One working path is enough to keep
 * receiving updates: a path that fails to register is reported through `onPartialFailure` and the
 * other stays registered. Only when both fail does the call reject.
 */
export type AppPreferencesPath = "broadcast" | "reply";

/** A preferences payload that is well formed but speaks another protocol version is not silent. */
function warnOnPreferencesVersionMismatch(payload: unknown) {
  if (
    typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload)
  ) {
    const version = (payload as Record<string, unknown>).apiVersion;
    if (
      typeof version === "number" &&
      version !== APP_PREFERENCES_API_VERSION
    ) {
      console.warn(
        `[protocol.version_mismatch] ${APP_PREFERENCES_EVENT}: 期望 ${APP_PREFERENCES_API_VERSION}，收到 ${version}`,
      );
    }
  }
}

export async function listenForAppPreferences(
  onPreferences: (preferences: AppPreferences) => void,
  onPartialFailure?: (path: AppPreferencesPath, reason: unknown) => void,
): Promise<UnlistenFn> {
  const results = await Promise.allSettled([
    getCurrentWebviewWindow().listen<unknown>(
      APP_PREFERENCES_EVENT,
      ({ payload }) => {
        if (isAppPreferences(payload)) onPreferences(payload);
        else warnOnPreferencesVersionMismatch(payload);
      },
    ),
    onWindowMessage<unknown>(APP_PREFERENCES_REPLY_MESSAGE, ({ payload }) => {
      if (isAppPreferences(payload)) onPreferences(payload);
      else warnOnPreferencesVersionMismatch(payload);
    }),
  ]);
  const stops = results.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  if (stops.length === 0) {
    const failed = results.find((result) => result.status === "rejected");
    throw failed && failed.status === "rejected"
      ? failed.reason
      : new Error("app preferences listeners were not registered");
  }
  const paths: AppPreferencesPath[] = ["broadcast", "reply"];
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      onPartialFailure?.(paths[index], result.reason);
    }
  });
  return () => {
    for (const stop of stops) stop();
  };
}

export async function requestInitialAppPreferences(windowLabel: string) {
  const request: AppPreferencesRequest = {
    apiVersion: APP_PREFERENCES_API_VERSION,
    windowLabel,
  };
  await sendWindowMessage(
    MAIN_WINDOW_LABEL,
    APP_PREFERENCES_REQUEST_MESSAGE,
    request,
  );
}

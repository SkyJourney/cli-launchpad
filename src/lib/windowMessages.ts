import { RUST_EVENTS } from "./eventNames";
import { sendWindowMessageCommand, type WindowInboxSource } from "./tauri";
import { onInboxEvent, type Unlisten } from "./windowInbox";

/**
 * 窗口之间的消息（m6-062，L2）：经 Rust 中继，Rust 按 `contracts/window-messages.json`
 * 校验消息类型、发送方与接收方类别，并在消息上盖发送方戳。信封外层固定为
 * `{ apiVersion, type, payload }`。本文件不使用翻译函数（R-FE-1）。
 */

export const WINDOW_MESSAGE_API_VERSION = 1 as const;

export interface WindowMessageEvent<T = unknown> {
  payload: T;
  /** Stamped by Rust from the calling webview; never taken from the payload. */
  source: WindowInboxSource;
  seq: number;
}

export type WindowMessageHandler<T = unknown> = (
  event: WindowMessageEvent<T>,
) => void | Promise<void>;

function isEnvelope(
  value: unknown,
): value is { apiVersion: number; type: string; payload: unknown } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.type === "string" &&
    typeof candidate.apiVersion === "number" &&
    "payload" in candidate
  );
}

/** Sends one message through the relay. Resolves to whether the target had an inbox. */
export async function sendWindowMessage(
  target: string,
  type: string,
  payload: unknown,
): Promise<boolean> {
  const result = await sendWindowMessageCommand(target, type, {
    apiVersion: WINDOW_MESSAGE_API_VERSION,
    type,
    payload,
  });
  return result.delivered;
}

/**
 * Listens for one message type. Messages without a stamped source, with another API version or
 * with a malformed envelope are dropped.
 */
export function onWindowMessage<T = unknown>(
  type: string,
  handler: WindowMessageHandler<T>,
): Promise<Unlisten> {
  return onInboxEvent<unknown>(RUST_EVENTS.windowMessage, (event) => {
    if (!isEnvelope(event.payload)) {
      console.warn("window_message.invalid_envelope", type);
      return;
    }
    const envelope = event.payload;
    if (envelope.type !== type) return;
    if (envelope.apiVersion !== WINDOW_MESSAGE_API_VERSION) {
      console.warn("window_message.unsupported_version", type);
      return;
    }
    if (event.source === null) {
      console.warn("window_message.missing_source", type);
      return;
    }
    return handler({
      payload: envelope.payload as T,
      source: event.source,
      seq: event.seq,
    });
  });
}

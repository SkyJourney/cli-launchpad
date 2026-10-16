import { Channel } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  subscribeWindowInbox,
  type InboxMessage,
  type WindowInboxSource,
} from "./tauri";

/**
 * 主窗口的私有收件箱（m6-061，L1）：Rust 发起的通知经 `subscribe_window_inbox` 提供的
 * Channel 送达，其他窗口既不能订阅也无法用全局 `listen` 窃听。
 *
 * 每个窗口只订阅一次；handler 在订阅调用返回之前就已登记，所以 Rust 在订阅时冲刷出来的
 * 缓冲消息不会丢失。本文件不使用翻译函数（R-FE-1）。
 */

export interface InboxEvent<T = unknown> {
  event: string;
  payload: T;
  seq: number;
  source: WindowInboxSource | null;
}

export type InboxHandler<T = unknown> = (
  event: InboxEvent<T>,
) => void | Promise<void>;

export type Unlisten = () => void;

interface HandlerEntry {
  handler: InboxHandler;
}

interface WindowInboxState {
  handlers: Map<string, Set<HandlerEntry>>;
  registrations: Map<string, number>;
  subscription: Promise<void> | null;
  subscribed: boolean;
}

const states = new Map<string, WindowInboxState>();

const SOURCE_KINDS = new Set(["main", "terminal", "workspaceContent"]);

function stateFor(label: string): WindowInboxState {
  let state = states.get(label);
  if (!state) {
    state = {
      handlers: new Map(),
      registrations: new Map(),
      subscription: null,
      subscribed: false,
    };
    states.set(label, state);
  }
  return state;
}

function isInboxMessage(message: unknown): message is InboxMessage {
  if (typeof message !== "object" || message === null) return false;
  const candidate = message as Record<string, unknown>;
  if (typeof candidate.seq !== "number") return false;
  if (typeof candidate.event !== "string" || candidate.event === "") {
    return false;
  }
  const source = candidate.source;
  if (source === null) return true;
  if (typeof source !== "object" || source === undefined) return false;
  const stamped = source as Record<string, unknown>;
  return (
    typeof stamped.label === "string" &&
    typeof stamped.kind === "string" &&
    SOURCE_KINDS.has(stamped.kind)
  );
}

function reportFailure(event: string, reason: unknown) {
  console.error(`window_inbox.handler_failed event=${event}`, reason);
}

function dispatch(label: string, message: unknown) {
  if (!isInboxMessage(message)) {
    console.warn("window_inbox.invalid_message");
    return;
  }
  const entries = states.get(label)?.handlers.get(message.event);
  if (!entries || entries.size === 0) return;
  const event: InboxEvent = {
    event: message.event,
    payload: message.payload,
    seq: message.seq,
    source: message.source,
  };
  for (const entry of [...entries]) {
    try {
      const result = entry.handler(event);
      if (result && typeof result.then === "function") {
        result.then(undefined, (reason: unknown) =>
          reportFailure(message.event, reason),
        );
      }
    } catch (reason) {
      reportFailure(message.event, reason);
    }
  }
}

function ensureSubscribed(
  label: string,
  state: WindowInboxState,
): Promise<void> {
  if (state.subscribed) return Promise.resolve();
  if (state.subscription) return state.subscription;
  const channel = new Channel<InboxMessage>();
  channel.onmessage = (message) => dispatch(label, message);
  const subscription = subscribeWindowInbox(channel).then(
    () => {
      state.subscribed = true;
    },
    (reason: unknown) => {
      // The next call retries with a fresh channel.
      state.subscription = null;
      throw reason;
    },
  );
  state.subscription = subscription;
  return subscription;
}

/**
 * 监听一个 Rust 通知。返回的 Unlisten 只移除这个 handler，不拆除订阅（拆除会让 Rust 之后
 * 发的消息发给一个已无人处理的 Channel）。订阅失败时移除 handler 并把错误抛给调用方，
 * 下一次调用会重试。
 */
export async function onInboxEvent<T = unknown>(
  event: string,
  handler: InboxHandler<T>,
): Promise<Unlisten> {
  const label = getCurrentWebviewWindow().label;
  const state = stateFor(label);
  const entry: HandlerEntry = { handler: handler as InboxHandler };
  let entries = state.handlers.get(event);
  if (!entries) {
    entries = new Set();
    state.handlers.set(event, entries);
  }
  entries.add(entry);
  state.registrations.set(event, (state.registrations.get(event) ?? 0) + 1);
  try {
    await ensureSubscribed(label, state);
  } catch (reason) {
    entries.delete(entry);
    throw reason;
  }
  return () => {
    state.handlers.get(event)?.delete(entry);
  };
}

// Only `tauriMock.reset()` calls this: it clears every window's subscription state.
export function resetWindowInboxForTests(): void {
  states.clear();
}

// Only the test mock reads this: how many handlers a window has for an event.
export function inboxHandlerCountForTests(
  label: string,
  event: string,
): number {
  return states.get(label)?.handlers.get(event)?.size ?? 0;
}

// Only the test mock reads this: how many handlers were ever registered for an event, which
// detects a listener that is torn down and registered again.
export function inboxRegistrationCountForTests(
  label: string,
  event: string,
): number {
  return states.get(label)?.registrations.get(event) ?? 0;
}

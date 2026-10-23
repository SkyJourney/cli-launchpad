import { Channel } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  REPLAY_STASH_LIMIT_DEFAULT,
  REPLAYABLE_RUST_EVENTS,
} from "./eventNames";
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
 * 缓冲消息不会丢失。订阅时冲刷出来、而对应事件的 handler 稍后才登记的消息：幂等事件
 * （REPLAYABLE_RUST_EVENTS，部分事件只留最新一条）按事件名有界暂存，登记 handler 时回放给当时已登记的全部 handler，超过 10 秒的不回放；带时效或
 * 带发送方语义的事件（window-message、pty-session-owner-lost、
 * workspace-content-window-lost）不暂存，直接丢弃，避免把过期的状态变化当成当前事实重放。
 * 本文件不使用翻译函数（R-FE-1）。
 */

/** 每个事件名最多暂存的消息数的默认值；超出时丢弃最旧的。 */
export const INBOX_PENDING_LIMIT = REPLAY_STASH_LIMIT_DEFAULT;

/** 暂存超过这个时长就不再回放：回放只为弥补启动期的先后顺序，不是历史重放。 */
export const REPLAY_MAX_AGE_MS = 10_000;

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

interface StashedEvent {
  event: InboxEvent;
  at: number;
}

interface WindowInboxState {
  handlers: Map<string, Set<HandlerEntry>>;
  registrations: Map<string, number>;
  pending: Map<string, StashedEvent[]>;
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
      pending: new Map(),
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
  const state = stateFor(label);
  const event: InboxEvent = {
    event: message.event,
    payload: message.payload,
    seq: message.seq,
    source: message.source,
  };
  const entries = state.handlers.get(message.event);
  // While older messages of this event wait for their replay, newer ones queue behind them so
  // that handlers see the events in order.
  const queued = state.pending.get(message.event);
  if (!entries || entries.size === 0 || (queued && queued.length > 0)) {
    stashReplayable(state, event);
    return;
  }
  for (const entry of [...entries]) {
    run(entry, event);
  }
}

function run(entry: HandlerEntry, event: InboxEvent) {
  try {
    const result = entry.handler(event);
    if (result && typeof result.then === "function") {
      result.then(undefined, (reason: unknown) =>
        reportFailure(event.event, reason),
      );
    }
  } catch (reason) {
    reportFailure(event.event, reason);
  }
}

function stashReplayable(state: WindowInboxState, event: InboxEvent) {
  const limit = REPLAYABLE_RUST_EVENTS[event.event];
  if (limit === undefined) return;
  let queue = state.pending.get(event.event);
  if (!queue) {
    queue = [];
    state.pending.set(event.event, queue);
  }
  queue.push({ event, at: Date.now() });
  while (queue.length > limit) queue.shift();
}

/** Hands the stashed messages of `event` to the handlers registered right now, oldest first. */
function replayPending(state: WindowInboxState, event: string) {
  const queue = state.pending.get(event);
  const targets = [...(state.handlers.get(event) ?? [])];
  // Without a live handler the stash stays for the next registration.
  if (!queue || targets.length === 0) return;
  state.pending.delete(event);
  const oldest = Date.now() - REPLAY_MAX_AGE_MS;
  for (const stashed of queue) {
    if (stashed.at < oldest) continue;
    for (const target of targets) run(target, stashed.event);
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
  // Messages that arrived before a handler of this event existed go to the handlers registered
  // now. A handler that was already unmounted ignores them itself.
  replayPending(state, event);
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

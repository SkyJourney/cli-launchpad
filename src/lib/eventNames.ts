/** Event names Rust sends to windows; contracts/events.json lists them and eventContract.test.ts compares. */
export const RUST_EVENTS = {
  appExitRequested: "app-exit-requested",
  executionTaskLog: "execution-task-log",
  executionTaskUpdated: "execution-task-updated",
  ptySessionOwnerLost: "pty-session-owner-lost",
  windowMessage: "window-message",
  workspaceContentWindowLost: "workspace-content-window-lost",
  workspaceDataRestored: "workspace-data-restored",
} as const;

/** Default number of messages the window inbox keeps per replayable event. */
export const REPLAY_STASH_LIMIT_DEFAULT = 64;

/**
 * Events that are safe to replay to a handler registered after the message arrived, with how many
 * messages the window inbox keeps for each (m6-b1920-14). Repeating or delaying them does not
 * change the outcome: an exit request is checked by its requestId and, like a restore
 * notification, only the newest one matters; the task events are idempotent updates.
 */
export const REPLAYABLE_RUST_EVENTS: Readonly<Record<string, number>> = {
  [RUST_EVENTS.appExitRequested]: 1,
  [RUST_EVENTS.workspaceDataRestored]: 1,
  [RUST_EVENTS.executionTaskUpdated]: REPLAY_STASH_LIMIT_DEFAULT,
  [RUST_EVENTS.executionTaskLog]: REPLAY_STASH_LIMIT_DEFAULT,
};

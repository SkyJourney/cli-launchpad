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

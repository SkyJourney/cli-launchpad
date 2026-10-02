import type { ToolKey } from "./tauri";

/// Single source of truth for react-query keys, so query definitions and
/// invalidations always agree (no stray string literals to drift).
export const qk = {
  directories: () => ["directories"],
  cliStatus: () => ["cli-status"],
  latestVersions: () => ["latest-version"],
  latestVersion: (toolKey: ToolKey) => ["latest-version", toolKey],
  backups: () => ["backups"],
  launchHistory: () => ["launch-history"],
  launchHistoryLimit: () => ["launch-history-limit"],
  cacheStats: () => ["cache-stats"],
  terminalEnvironment: () => ["terminal-environment"],
  launchTarget: () => ["launch-target"],
  closeBehavior: () => ["close-behavior"],
  appVersion: () => ["app-version"],
  executionTasks: () => ["execution-tasks", "list"],
  executionTask: (taskId: string) => ["execution-tasks", "detail", taskId],
  executionReconciliations: () => ["execution-tasks", "reconciliations"],
  sessions: (directoryId: number | null, toolKey: ToolKey) => [
    "sessions",
    "pages",
    directoryId,
    toolKey,
  ],
  sessionSearches: (directoryId: number | null) => [
    "sessions",
    "search",
    directoryId,
  ],
  sessionSearchIndex: (directoryId: number | null) => [
    "sessionSearchIndex",
    directoryId,
  ],
  sessionSearch: (
    directoryId: number | null,
    query: string,
    indexRevision?: number,
  ) => ["sessions", "search", directoryId, query, indexRevision],
};

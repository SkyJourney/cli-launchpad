import { Channel, invoke } from "@tauri-apps/api/core";

export type ToolKey = "antigravity" | "codex" | "claude" | "grok" | "hermes";

export type WorkspaceLayoutNode =
  | {
      kind: "pane";
      id: string;
      paneNumber: number;
      contents: WorkspacePaneContentRef[];
      activeContent?: WorkspacePaneContentRef | null;
    }
  | {
      kind: "split";
      id: string;
      direction: "horizontal" | "vertical";
      ratio: number;
      first: WorkspaceLayoutNode;
      second: WorkspaceLayoutNode;
    };

export type WorkspaceSlotTitle =
  | { kind: "automatic" }
  | { kind: "custom"; value: string };

export interface WorkspaceLayoutSlot {
  instanceId: string;
  directoryId: number;
  directoryPath: string;
  projectName: string;
  toolKey: ToolKey;
  sequence: number;
  sessionId: string | null;
  resumeSessionId: string | null;
  title: WorkspaceSlotTitle;
}

export interface WorkspaceLayoutDocument {
  schemaVersion: number;
  tree: WorkspaceLayoutNode;
  focusedPaneId: string;
  slots: WorkspaceLayoutSlot[];
  documents: WorkspaceFileDocument[];
  detachedSlotIds: string[];
}

export type WorkspacePaneContentRef =
  | { kind: "pty"; slotId: string }
  | { kind: "file"; documentId: string };

export interface WorkspaceFileDocument {
  id: string;
  directoryId: number;
  directoryPath: string;
  relativePath: string;
}

export type WorkspaceLayoutStateStatus =
  | { status: "missing" }
  | { status: "ready" }
  | { status: "needsReset"; reason: string };

export type WorkspaceSlotStateKind =
  | "pending"
  | "running"
  | "ended"
  | "missingProject"
  | "projectIdentityMismatch"
  | "missingSession"
  | "sessionIdentityMismatch";

export interface WorkspaceSlotState {
  instanceId: string;
  state: WorkspaceSlotStateKind;
  currentProjectName: string | null;
}

export interface WorkspaceLayoutStateRead {
  status: WorkspaceLayoutStateStatus;
  revision: number | null;
  schemaVersion: number | null;
  updatedAtMs: number | null;
  layout: WorkspaceLayoutDocument | null;
  slotStates: WorkspaceSlotState[];
}

export interface WorkspaceLayoutSaveResult {
  saved: boolean;
  revision: number;
}

export interface WorkspaceLayoutPresetSummary {
  id: string;
  name: string;
  schemaVersion: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface WorkspaceLayoutPreset {
  summary: WorkspaceLayoutPresetSummary;
  layout: WorkspaceLayoutDocument;
  slotStates: WorkspaceSlotState[];
}

export interface WorkspaceLayoutApplyPlan {
  layout: WorkspaceLayoutDocument;
  slotStates: WorkspaceSlotState[];
}

export interface Directory {
  id: number;
  name: string;
  path: string;
  sortOrder: number;
  pinned: boolean;
  lastUsedAt: string | null;
  note: string | null;
}

export interface ProjectFileEntry {
  name: string;
  relativePath: string;
  kind: "directory" | "file" | "other";
  size: number;
  hidden: boolean;
  ignored: boolean;
  symbolicLink: boolean;
}

export interface ProjectDirectoryListing {
  entries: ProjectFileEntry[];
  truncated: boolean;
}

export interface WorkspaceFileMetadata {
  relativePath: string;
  kind: "directory" | "file" | "other";
  extension: string | null;
  size: number;
  modifiedAtMs: number | null;
  hidden: boolean;
  ignored: boolean;
  symbolicLink: boolean;
}

export interface WorkspaceFileIndex {
  entries: WorkspaceFileMetadata[];
  truncated: boolean;
  scannedAtMs: number;
}

export interface ProjectTextFile {
  content: string;
  revision: string;
}

export type ProjectTextFileSaveResult =
  | { kind: "saved"; content: string; revision: string }
  | { kind: "conflict" };

export type ProjectFileOpenResult =
  | { kind: "text"; content: string; revision: string }
  | { kind: "image"; mimeType: string; base64Data: string }
  | {
      kind: "unsupported";
      reason: "binary" | "tooLarge" | "invalidImage" | "unsupportedImage";
    };

export type CloseBehavior = "minimize_to_tray" | "quit";

export type TerminalDistribution =
  | "stable"
  | "preview"
  | "canary"
  | "unpackaged";
export type ShellFamily = "pwsh" | "windows_power_shell" | "cmd" | "unknown";
export type ProfilePreservation =
  | "exact"
  | "command_continuation"
  | "appearance_only";

export interface TerminalProfileTarget {
  targetId: string;
  name: string;
  guid: string;
  source: string | null;
  isDefault: boolean;
  shellFamily: ShellFamily;
  preservation: ProfilePreservation;
  preservationReason: string;
}

export interface WindowsTerminalHost {
  id: string;
  distribution: TerminalDistribution;
  displayName: string;
  executablePath: string;
  version: string | null;
  supportsAppendCommandLine: boolean;
  settingsPath: string | null;
  profiles: TerminalProfileTarget[];
}

export interface DirectShellTarget {
  targetId: string;
  displayName: string;
  shellFamily: ShellFamily;
  executablePath: string;
  priority: number;
}

export type TerminalPlatform = "windows" | "macos" | "linux" | "other";
export type MacosTerminalLaunchMode =
  | "command_document"
  | "apple_script"
  | "direct_arguments";

export interface MacosTerminalHost {
  targetId: string;
  displayName: string;
  applicationPath: string;
  bundleIdentifier: string;
  executablePath: string | null;
  version: string | null;
  launchMode: MacosTerminalLaunchMode;
}

export type LinuxTerminalLaunchMode =
  | "xdg_terminal_exec"
  | "direct_arguments"
  | "shell_wrapped";

export interface LinuxTerminalHost {
  targetId: string;
  displayName: string;
  executablePath: string;
  launchMode: LinuxTerminalLaunchMode;
}

export interface TerminalEnvironment {
  platform: TerminalPlatform;
  windowsTerminalHosts: WindowsTerminalHost[];
  macosTerminalHosts: MacosTerminalHost[];
  linuxTerminalHosts: LinuxTerminalHost[];
  directShells: DirectShellTarget[];
  recommendedTargetId: string | null;
  warnings: string[];
}

export interface SessionInfo {
  toolKey: ToolKey;
  sessionId: string;
  title: string;
  alias: string | null;
  lastActiveMs: number | null;
}

export interface SessionPage {
  items: SessionInfo[];
  nextCursor: string | null;
}

export interface SessionSearchResults {
  items: SessionInfo[];
  incompleteTools: ToolKey[];
}

export interface SessionSearchIndexRefresh {
  incompleteTools: ToolKey[];
  indexedSessions: number;
}

export interface PtySession {
  sessionId: string;
  directoryId: number;
  toolKey: ToolKey;
  workingDirectory: string;
  state: "running" | "exited" | "terminated" | "failed";
  startedAtMs: number;
  endedAtMs: number | null;
  exitCode: number | null;
}

export type PtySessionWindowStatus =
  | "running"
  | "ended"
  | "ownedByAnotherWindow";

export interface PtySizeUpdate {
  cols: number;
  rows: number;
  pixelWidth: number;
  pixelHeight: number;
}

export interface PtyHandoff {
  token: string;
  sequence: number;
}

export interface PtyTerminalSnapshot {
  data: string;
  cols: number;
  rows: number;
}

export type PtyEvent =
  | { type: "output"; sessionId: string; sequence: number; dataBase64: string }
  | {
      type: "snapshot";
      sessionId: string;
      sequence: number;
      data: string;
      cols: number;
      rows: number;
    }
  | {
      type: "exited";
      sessionId: string;
      state: PtySession["state"];
      exitCode: number | null;
    }
  | { type: "failed"; sessionId: string; message: string };

export type PtyFrontendStage =
  | "startupInputFlushed"
  | "outputReceived"
  | "outputDecodeFailed"
  | "xtermWritePending"
  | "xtermWriteCompleted"
  | "xtermWriteFailed"
  | "rendererPaused"
  | "rendererResumed";

export type InstallKind = "install" | "update";

export interface InstallPlan {
  toolKey: ToolKey;
  kind: InstallKind;
  program: string;
  args: string[];
  source: string;
  preview: string;
  effects: string | null;
}

export type ExecutionStatus =
  | "preparing"
  | "running"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "interrupted";

export type ExecutionStream = "stdout" | "stderr" | "system";

export interface ExecutionTask {
  id: string;
  toolKey: ToolKey;
  kind: InstallKind;
  source: string;
  preview: string;
  status: ExecutionStatus;
  startedAtMs: number;
  finishedAtMs: number | null;
  exitCode: number | null;
  errorMessage: string | null;
  logTruncated: boolean;
}

export interface ExecutionLogChunk {
  taskId: string;
  sequence: number;
  stream: ExecutionStream;
  content: string;
  createdAtMs: number;
}

export interface ExecutionTaskDetail {
  task: ExecutionTask;
  logs: ExecutionLogChunk[];
}

export interface LatestVersion {
  toolKey: ToolKey;
  latest: string | null;
  updateAvailable: boolean | null;
  commitsBehind: number | null;
  error: string | null;
  fromCache: boolean;
  managedUpdateAllowed: boolean;
  managementMessage: string | null;
}

export type BackupReason =
  | "manual"
  | "pre_import"
  | "pre_restore"
  | "pre_migration";

export interface BackupManifest {
  id: string;
  createdAtMs: number;
  reason: BackupReason;
  schemaVersion: number;
  databaseFilename: string;
  sizeBytes: number;
}

export interface LaunchHistoryEntry {
  id: number;
  directoryName: string;
  directoryPath: string;
  toolKey: ToolKey;
  action: "launch" | "resume";
  success: boolean;
  errorCategory: string | null;
  launchedAt: string;
  ptySessionId: string | null;
}

export interface CacheStats {
  sizeBytes: number;
  entryCount: number;
  sessionEntryCount: number;
  newestEntryAtMs: number | null;
}

export type CliAvailability = "available" | "missing" | "unknown";

export interface CliStatus {
  toolKey: ToolKey;
  status: CliAvailability;
  path: string | null;
  resolvedCommand: string | null;
  version: string | null;
  versionError: string | null;
  latestVersion: string | null;
}

// Directories
export function listDirectories() {
  return invoke<Directory[]>("list_directories");
}

export function addDirectory(name: string, path: string, note?: string | null) {
  return invoke<Directory>("add_directory", { name, path, note: note ?? null });
}

export function updateDirectory(
  id: number,
  name: string,
  note?: string | null,
) {
  return invoke<void>("update_directory", { id, name, note: note ?? null });
}

export function removeDirectory(id: number) {
  return invoke<void>("remove_directory", { id });
}

export function setDirectoryPinned(id: number, pinned: boolean) {
  return invoke<void>("set_directory_pinned", { id, pinned });
}

export function reorderDirectories(orderedIds: number[], pinned: boolean) {
  return invoke<void>("reorder_directories", { orderedIds, pinned });
}

export function openProjectDirectory(id: number) {
  return invoke<void>("open_project_directory", { id });
}

export function listProjectFiles(directoryId: number, relativePath = "") {
  return invoke<ProjectDirectoryListing>("list_project_files", {
    directoryId,
    relativePath,
  });
}

export function getWorkspaceFileIndex(
  directoryId: number,
  forceRefresh = false,
) {
  return invoke<WorkspaceFileIndex>("get_workspace_file_index", {
    directoryId,
    forceRefresh,
  });
}

export function readProjectTextFile(directoryId: number, relativePath: string) {
  return invoke<ProjectTextFile>("read_project_text_file", {
    directoryId,
    relativePath,
  });
}

export function openProjectFile(directoryId: number, relativePath: string) {
  return invoke<ProjectFileOpenResult>("open_project_file", {
    directoryId,
    relativePath,
  });
}

export function saveProjectTextFile(
  directoryId: number,
  relativePath: string,
  content: string,
  expectedRevision: string,
) {
  return invoke<ProjectTextFileSaveResult>("save_project_text_file", {
    directoryId,
    relativePath,
    content,
    expectedRevision,
  });
}

// CLI detection
export function detectCliStatus(force = false) {
  return invoke<CliStatus[]>("detect_cli_status", { force });
}

// Config backup (file-based)
export function exportConfigToPath(path: string) {
  return invoke<void>("export_config_to_path", { path });
}

export function importConfigFromPath(path: string) {
  return invoke<void>("import_config_from_path", { path });
}

export function exportDiagnosticsToPath(path: string) {
  return invoke<void>("export_diagnostics_to_path", { path });
}

export function listBackups() {
  return invoke<BackupManifest[]>("list_backups");
}

export function createBackup() {
  return invoke<BackupManifest>("create_backup");
}

export function restoreBackup(backupId: string) {
  return invoke<BackupManifest>("restore_backup", { backupId });
}

export function listLaunchHistory() {
  return invoke<LaunchHistoryEntry[]>("list_launch_history");
}

export function clearLaunchHistory() {
  return invoke<void>("clear_launch_history");
}

export function getLaunchHistoryLimit() {
  return invoke<number>("get_launch_history_limit");
}

export function setLaunchHistoryLimit(limit: number) {
  return invoke<void>("set_launch_history_limit", { limit });
}

// Version & install/update
export function fetchLatestVersion(toolKey: ToolKey, force = false) {
  return invoke<LatestVersion>("fetch_latest_version", {
    toolKey,
    force,
  });
}

export function getInstallPlan(toolKey: ToolKey, kind: InstallKind) {
  return invoke<InstallPlan>("get_install_plan", { toolKey, kind });
}

export function startExecutionTask(toolKey: ToolKey, kind: InstallKind) {
  return invoke<ExecutionTask>("start_execution_task", { toolKey, kind });
}

export function listExecutionTasks() {
  return invoke<ExecutionTask[]>("list_execution_tasks");
}

export function getExecutionTask(taskId: string) {
  return invoke<ExecutionTaskDetail>("get_execution_task", { taskId });
}

export function cancelExecutionTask(taskId: string) {
  return invoke<ExecutionTask>("cancel_execution_task", { taskId });
}

export function clearExecutionTask(taskId: string) {
  return invoke<void>("clear_execution_task", { taskId });
}

export function clearExecutionHistory() {
  return invoke<number>("clear_execution_history");
}

// Embedded PTY sessions
export function getWorkspaceLayout() {
  return invoke<WorkspaceLayoutStateRead>("get_workspace_layout");
}

export function saveWorkspaceLayout(
  revision: number,
  layout: WorkspaceLayoutDocument,
) {
  return invoke<WorkspaceLayoutSaveResult>("save_workspace_layout", {
    revision,
    layout,
  });
}

export function resetWorkspaceLayout() {
  return invoke<number>("reset_workspace_layout");
}

export function listWorkspaceLayoutPresets() {
  return invoke<WorkspaceLayoutPresetSummary[]>(
    "list_workspace_layout_presets",
  );
}

export function getWorkspaceLayoutPreset(id: string) {
  return invoke<WorkspaceLayoutPreset>("get_workspace_layout_preset", { id });
}

export function createWorkspaceLayoutPreset(
  name: string,
  layout: WorkspaceLayoutDocument,
) {
  return invoke<WorkspaceLayoutPresetSummary>(
    "create_workspace_layout_preset",
    { name, layout },
  );
}

export function updateWorkspaceLayoutPreset(
  id: string,
  layout: WorkspaceLayoutDocument,
) {
  return invoke<boolean>("update_workspace_layout_preset", { id, layout });
}

export function renameWorkspaceLayoutPreset(id: string, name: string) {
  return invoke<boolean>("rename_workspace_layout_preset", { id, name });
}

export function deleteWorkspaceLayoutPreset(id: string) {
  return invoke<boolean>("delete_workspace_layout_preset", { id });
}

export function planApplyWorkspaceLayoutPreset(
  id: string,
  activeLayout: WorkspaceLayoutDocument,
) {
  return invoke<WorkspaceLayoutApplyPlan>(
    "plan_apply_workspace_layout_preset",
    { id, activeLayout },
  );
}

export function createPtySession(
  directoryId: number,
  toolKey: ToolKey,
  size: PtySizeUpdate,
  onEvent: Channel<PtyEvent>,
  resumeSessionId?: string,
) {
  return invoke<PtySession>("create_pty_session", {
    directoryId,
    toolKey,
    size,
    onEvent,
    resumeSessionId,
  });
}

export function beginPtyHandoff(sessionId: string) {
  return invoke<PtyHandoff>("begin_pty_handoff", { sessionId });
}

export function stagePtyHandoffSnapshot(
  sessionId: string,
  token: string,
  sequence: number,
  snapshot: PtyTerminalSnapshot,
) {
  return invoke<void>("stage_pty_handoff_snapshot", {
    sessionId,
    token,
    sequence,
    snapshot,
  });
}

export function completePtyHandoff(
  sessionId: string,
  token: string,
  onEvent: Channel<PtyEvent>,
) {
  return invoke<PtySession>("complete_pty_handoff", {
    sessionId,
    token,
    onEvent,
  });
}

export function finalizePtyHandoff(
  sessionId: string,
  token: string,
  size: PtySizeUpdate,
) {
  return invoke<PtySession>("finalize_pty_handoff", { sessionId, token, size });
}

export function cancelPtyHandoff(sessionId: string, token: string) {
  return invoke<void>("cancel_pty_handoff", { sessionId, token });
}

export function getPtySessionWindowStatus(sessionId: string) {
  return invoke<PtySessionWindowStatus>("get_pty_session_window_status", {
    sessionId,
  });
}

export function writePtySession(sessionId: string, data: string) {
  return invoke<void>("write_pty_session", { sessionId, data });
}

export function resizePtySession(sessionId: string, size: PtySizeUpdate) {
  return invoke<void>("resize_pty_session", { sessionId, size });
}

export function acknowledgePtyOutput(sessionId: string, sequence: number) {
  return invoke<void>("acknowledge_pty_output", { sessionId, sequence });
}

export function reportPtyFrontendStage(
  sessionId: string,
  stage: PtyFrontendStage,
) {
  return invoke<void>("report_pty_frontend_stage", { sessionId, stage });
}

export function terminatePtySession(sessionId: string) {
  return invoke<void>("terminate_pty_session", { sessionId });
}

export function confirmPtyExit() {
  return invoke<void>("confirm_pty_exit");
}

// Terminal environment and launch target
export function detectTerminalEnvironment(force = false) {
  return invoke<TerminalEnvironment>("detect_terminal_environment", { force });
}

export function getLaunchTarget() {
  return invoke<string>("get_launch_target");
}

export function setLaunchTarget(targetId: string) {
  return invoke<void>("set_launch_target", { targetId });
}

export function getCloseBehavior() {
  return invoke<CloseBehavior>("get_close_behavior");
}

export function setCloseBehavior(closeBehavior: CloseBehavior) {
  return invoke<void>("set_close_behavior", { closeBehavior });
}

// Sessions
export function listSessionPage(
  directoryId: number,
  toolKey: ToolKey,
  cursor: string | null = null,
  limit = 10,
) {
  return invoke<SessionPage>("list_sessions", {
    directoryId,
    toolKey,
    cursor,
    limit,
  });
}

export function searchSessions(directoryId: number, query: string) {
  return invoke<SessionSearchResults>("search_sessions", {
    directoryId,
    query,
  });
}

export function refreshSessionSearchIndex(directoryId: number) {
  return invoke<SessionSearchIndexRefresh>("refresh_session_search_index", {
    directoryId,
  });
}

export function setSessionAlias(
  directoryId: number,
  toolKey: ToolKey,
  sessionId: string,
  alias: string,
) {
  return invoke<void>("set_session_alias", {
    directoryId,
    toolKey,
    sessionId,
    alias,
  });
}

export function deleteSessionAlias(
  directoryId: number,
  toolKey: ToolKey,
  sessionId: string,
) {
  return invoke<void>("delete_session_alias", {
    directoryId,
    toolKey,
    sessionId,
  });
}

export function getCacheStats() {
  return invoke<CacheStats>("get_cache_stats");
}

export function clearCache() {
  return invoke<void>("clear_cache");
}

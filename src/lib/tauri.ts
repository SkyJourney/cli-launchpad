import { invoke } from "@tauri-apps/api/core";

export type ToolKey = "antigravity" | "codex" | "claude";

export interface Directory {
  id: number;
  name: string;
  path: string;
  sortOrder: number;
  pinned: boolean;
  lastUsedAt: string | null;
  note: string | null;
}

export interface Tool {
  id: number;
  key: ToolKey;
  displayName: string;
  executable: string;
  globalArgs: string;
  enabled: boolean;
}

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

export type TerminalPlatform = "windows" | "macos" | "other";
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

export interface TerminalEnvironment {
  platform: TerminalPlatform;
  windowsTerminalHosts: WindowsTerminalHost[];
  macosTerminalHosts: MacosTerminalHost[];
  directShells: DirectShellTarget[];
  recommendedTargetId: string | null;
  warnings: string[];
}

export interface DirectoryToolArgs {
  directoryId: number;
  toolKey: ToolKey;
  args: string;
}

export interface ToolArgsUpdate {
  toolKey: ToolKey;
  args: string;
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

export interface ModelOption {
  value: string;
  label: string;
  isDefault: boolean;
}

export interface ModelCatalog {
  toolKey: ToolKey;
  options: ModelOption[];
  source: string;
  fromCache: boolean;
  warning: string | null;
}

export type InstallKind = "install" | "update";

export interface InstallPlan {
  toolKey: ToolKey;
  kind: InstallKind;
  program: string;
  args: string[];
  source: string;
  preview: string;
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
  error: string | null;
  fromCache: boolean;
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
  toolKey: ToolKey;
  action: "launch" | "resume";
  success: boolean;
  errorCategory: string | null;
  launchedAt: string;
}

export interface CacheStats {
  sizeBytes: number;
  entryCount: number;
  sessionEntryCount: number;
  newestEntryAtMs: number | null;
}

export type CliAvailability = "available" | "missing";

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

export function openProjectDirectory(id: number) {
  return invoke<void>("open_project_directory", { id });
}

// Tools
export function listTools() {
  return invoke<Tool[]>("list_tools");
}

export function saveToolGlobalArgsBatch(updates: ToolArgsUpdate[]) {
  return invoke<void>("save_tool_global_args_batch", { updates });
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

// Version & install/update
export function fetchLatestVersions(force = false) {
  return invoke<LatestVersion[]>("fetch_latest_versions", { force });
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

// Directory-level tool arguments
export function getDirectoryToolArgs(directoryId: number) {
  return invoke<DirectoryToolArgs[]>("get_directory_tool_args", {
    directoryId,
  });
}

export function saveDirectoryToolArgsBatch(
  directoryId: number,
  updates: ToolArgsUpdate[],
) {
  return invoke<void>("save_directory_tool_args_batch", {
    directoryId,
    updates,
  });
}

// Launch
export function previewLaunch(directoryId: number, toolKey: ToolKey) {
  return invoke<string>("preview_launch", { directoryId, toolKey });
}

export function launchTool(directoryId: number, toolKey: ToolKey) {
  return invoke<void>("launch_tool", { directoryId, toolKey });
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

export function resumeSession(
  directoryId: number,
  toolKey: ToolKey,
  sessionId: string,
) {
  return invoke<void>("resume_session", { directoryId, toolKey, sessionId });
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

export function getModelCatalog(toolKey: ToolKey, force = false) {
  return invoke<ModelCatalog>("get_model_catalog", { toolKey, force });
}

export function getCacheStats() {
  return invoke<CacheStats>("get_cache_stats");
}

export function clearCache() {
  return invoke<void>("clear_cache");
}

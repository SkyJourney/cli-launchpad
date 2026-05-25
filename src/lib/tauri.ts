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

export type ShellKind = "wt-pwsh" | "pwsh" | "cmd";

export interface ShellProfile {
  id: number;
  name: string;
  terminalExe: string;
  shellExe: string;
  shellArgs: string;
  initScript: string;
  isDefault: boolean;
  kind: ShellKind;
}

export interface DirectoryToolArgs {
  directoryId: number;
  toolKey: ToolKey;
  args: string;
}

export interface SessionInfo {
  toolKey: ToolKey;
  sessionId: string;
  title: string;
  lastActiveMs: number | null;
  sourcePath: string;
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

export interface InstallOutcome {
  success: boolean;
  log: string;
}

export interface LatestVersion {
  toolKey: ToolKey;
  latest: string | null;
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

export type CliAvailability = "available" | "missing";

export interface CliStatus {
  toolKey: ToolKey;
  status: CliAvailability;
  path: string | null;
  resolvedCommand: string | null;
  version: string | null;
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

// Tools
export function listTools() {
  return invoke<Tool[]>("list_tools");
}

export function saveToolGlobalArgs(toolKey: ToolKey, args: string) {
  return invoke<void>("save_tool_global_args", { toolKey, args });
}

// CLI detection
export function detectCliStatus() {
  return invoke<CliStatus[]>("detect_cli_status");
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

// Version & install/update
export function fetchLatestVersions() {
  return invoke<LatestVersion[]>("fetch_latest_versions");
}

export function getInstallPlan(toolKey: ToolKey, kind: InstallKind) {
  return invoke<InstallPlan>("get_install_plan", { toolKey, kind });
}

export function runInstall(toolKey: ToolKey, kind: InstallKind) {
  return invoke<InstallOutcome>("run_install", { toolKey, kind });
}

// Shell profiles
export function getShellProfiles() {
  return invoke<ShellProfile[]>("get_shell_profiles");
}

export function saveShellProfile(profile: ShellProfile) {
  return invoke<void>("save_shell_profile", { profile });
}

export function setShellKind(kind: ShellKind) {
  return invoke<void>("set_shell_kind", { kind });
}

// Directory-level tool arguments
export function getDirectoryToolArgs(directoryId: number) {
  return invoke<DirectoryToolArgs[]>("get_directory_tool_args", {
    directoryId,
  });
}

export function saveDirectoryToolArgs(
  directoryId: number,
  toolKey: ToolKey,
  args: string,
) {
  return invoke<void>("save_directory_tool_args", {
    directoryId,
    toolKey,
    args,
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
export function listSessions(directoryId: number, toolKey: ToolKey) {
  return invoke<SessionInfo[]>("list_sessions", { directoryId, toolKey });
}

export function resumeSession(
  directoryId: number,
  toolKey: ToolKey,
  sessionId: string,
) {
  return invoke<void>("resume_session", { directoryId, toolKey, sessionId });
}

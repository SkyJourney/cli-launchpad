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

export interface ShellProfile {
  id: number;
  name: string;
  terminalExe: string;
  shellExe: string;
  shellArgs: string;
  initScript: string;
  isDefault: boolean;
}

export interface DirectoryToolArgs {
  directoryId: number;
  toolKey: ToolKey;
  args: string;
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

// Shell profiles
export function getShellProfiles() {
  return invoke<ShellProfile[]>("get_shell_profiles");
}

export function saveShellProfile(profile: ShellProfile) {
  return invoke<void>("save_shell_profile", { profile });
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

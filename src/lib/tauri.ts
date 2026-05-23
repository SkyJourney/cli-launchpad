import { invoke } from "@tauri-apps/api/core";

export type LaunchToolKey = "antigravity" | "codex" | "claude";

export async function previewLaunch(directoryId: number, toolKey: LaunchToolKey) {
  return invoke<string>("preview_launch", { directoryId, toolKey });
}

export async function launchTool(directoryId: number, toolKey: LaunchToolKey) {
  return invoke<void>("launch_tool", { directoryId, toolKey });
}


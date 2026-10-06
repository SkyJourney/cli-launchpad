import type { ComponentType } from "react";
import type { ExecutionStream, InstallKind, ToolKey } from "../tauri";

export type TerminalPasteBehavior = {
  controlV: "clipboard" | "control-v" | "terminal";
  windowsAltV: "escape-v" | "terminal";
};

export interface InstallEffectsNotice {
  headingKey: string;
  effectKeys: string[];
}

export type CliPlatform = "windows" | "macos" | "linux";

export interface CliAdapter {
  key: ToolKey;
  label: string;
  shortLabel: string;
  icon: ComponentType<{ size?: number | string }>;
  terminalPaste: TerminalPasteBehavior;
  latestStatusKind: "version" | "branch-update";
  installEffects?: (platform: CliPlatform) => InstallEffectsNotice | undefined;
  showCommandNotice(kind: InstallKind): boolean;
  refreshLatestAfterExecution(kind: InstallKind): boolean;
  displayExecutionStream(
    kind: InstallKind,
    stream: ExecutionStream,
  ): ExecutionStream;
}

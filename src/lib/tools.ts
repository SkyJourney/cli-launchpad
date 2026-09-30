import type { ComponentType } from "react";
import antigravityIcon from "../assets/icons/brands/antigravity.svg";
import claudeCodeIcon from "../assets/icons/brands/claude-code.svg";
import codexIcon from "../assets/icons/brands/codex.svg";
import grokIcon from "../assets/icons/brands/grok.svg";
import { createSvgAssetIcon } from "../components/SvgAssetIcon";
import type { LatestVersion, ToolKey } from "./tauri";

type IconComponent = ComponentType<{ size?: number | string }>;

const AntigravityIcon = createSvgAssetIcon(antigravityIcon);
const ClaudeCodeIcon = createSvgAssetIcon(claudeCodeIcon);
const CodexIcon = createSvgAssetIcon(codexIcon);
const GrokIcon = createSvgAssetIcon(grokIcon, true);

export interface ToolMeta {
  key: ToolKey;
  label: string;
  shortLabel: string;
  icon: IconComponent;
  /// Display accent color when the tool has a verified brand asset.
  colorPrimary?: string;
  /// Whether installation and update actions are available in Settings.
  settingsActions: boolean;
}

/// Display order across the app: Claude, Codex, Antigravity, Grok Build.
export const TOOLS: ToolMeta[] = [
  {
    key: "claude",
    label: "Claude Code",
    shortLabel: "CC",
    icon: ClaudeCodeIcon,
    colorPrimary: "#D97757",
    settingsActions: true,
  },
  {
    key: "codex",
    label: "Codex",
    shortLabel: "CDX",
    icon: CodexIcon,
    colorPrimary: "#ffffff",
    settingsActions: true,
  },
  {
    key: "antigravity",
    label: "Antigravity",
    shortLabel: "AGY",
    icon: AntigravityIcon,
    colorPrimary: "#ffffff",
    settingsActions: true,
  },
  {
    key: "grok",
    label: "Grok Build",
    shortLabel: "GB",
    icon: GrokIcon,
    settingsActions: true,
  },
];

export function getTerminalTitleLabel(toolKey: ToolKey): string {
  return TOOLS.find((tool) => tool.key === toolKey)?.shortLabel ?? toolKey;
}

export function isManagedUpdateAllowed(
  toolKey: ToolKey,
  latest: Pick<LatestVersion, "managedUpdateAllowed"> | undefined,
): boolean {
  return toolKey !== "grok" || latest?.managedUpdateAllowed === true;
}

/// An empty `Record<ToolKey, string>` derived from TOOLS, so the per-tool arg
/// maps stay in sync with the tool list.
export function emptyToolMap(): Record<ToolKey, string> {
  return TOOLS.reduce(
    (acc, tool) => {
      acc[tool.key] = "";
      return acc;
    },
    {} as Record<ToolKey, string>,
  );
}

import type { ComponentType } from "react";
// Import only the colored SVG sub-component + brand color, not each brand's
// index barrel (which also pulls Avatar/Combine/Text/Mono and bloats the build).
import AntigravityColor from "@lobehub/icons/es/Antigravity/components/Color";
import { COLOR_PRIMARY as ANTIGRAVITY_COLOR } from "@lobehub/icons/es/Antigravity/style";
import ClaudeCodeColor from "@lobehub/icons/es/ClaudeCode/components/Color";
import { COLOR_PRIMARY as CLAUDE_COLOR } from "@lobehub/icons/es/ClaudeCode/style";
import CodexColor from "@lobehub/icons/es/Codex/components/Color";
import { COLOR_PRIMARY as CODEX_COLOR } from "@lobehub/icons/es/Codex/style";
import type { ToolKey } from "./tauri";

type IconComponent = ComponentType<{ size?: number | string }>;

export interface ToolMeta {
  key: ToolKey;
  label: string;
  shortLabel: string;
  icon: IconComponent;
  /// Official brand color, used for accents.
  colorPrimary: string;
}

/// Display order across the app: Claude, Codex, Antigravity. Icons are the
/// official colored brand marks from @lobehub/icons.
export const TOOLS: ToolMeta[] = [
  {
    key: "claude",
    label: "Claude Code",
    shortLabel: "C",
    icon: ClaudeCodeColor,
    colorPrimary: CLAUDE_COLOR,
  },
  {
    key: "codex",
    label: "Codex",
    shortLabel: "X",
    icon: CodexColor,
    colorPrimary: CODEX_COLOR,
  },
  {
    key: "antigravity",
    label: "Antigravity",
    shortLabel: "A",
    icon: AntigravityColor,
    colorPrimary: ANTIGRAVITY_COLOR,
  },
];

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

/// Quick-select presets for Claude's `--model` flag.
export interface ModelPreset {
  label: string;
  value: string | null;
}

export const CLAUDE_MODEL_PRESETS: ModelPreset[] = [
  { label: "默认", value: null },
  { label: "Opus 4.7", value: "claude-opus-4-7" },
  { label: "Sonnet 4.6", value: "claude-sonnet-4-6" },
  { label: "Haiku 4.5", value: "claude-haiku-4-5" },
];

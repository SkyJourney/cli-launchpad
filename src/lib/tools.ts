import { Bot, Code2, Rocket, type LucideIcon } from "lucide-react";
import type { ToolKey } from "./tauri";

export interface ToolMeta {
  key: ToolKey;
  label: string;
  shortLabel: string;
  icon: LucideIcon;
}

/// Display order across the app: Claude, Codex, Antigravity.
export const TOOLS: ToolMeta[] = [
  { key: "claude", label: "Claude Code", shortLabel: "C", icon: Bot },
  { key: "codex", label: "Codex", shortLabel: "X", icon: Code2 },
  { key: "antigravity", label: "Antigravity", shortLabel: "A", icon: Rocket },
];

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

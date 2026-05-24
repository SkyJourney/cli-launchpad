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

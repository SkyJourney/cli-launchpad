import type { ComponentType } from "react";
import antigravityIcon from "../assets/icons/brands/antigravity.svg";
import claudeCodeIcon from "../assets/icons/brands/claude-code.svg";
import codexIcon from "../assets/icons/brands/codex.svg";
import { createSvgAssetIcon } from "../components/SvgAssetIcon";
import type { ToolKey } from "./tauri";

type IconComponent = ComponentType<{ size?: number | string }>;

const AntigravityIcon = createSvgAssetIcon(antigravityIcon);
const ClaudeCodeIcon = createSvgAssetIcon(claudeCodeIcon);
const CodexIcon = createSvgAssetIcon(codexIcon);

export interface ToolMeta {
  key: ToolKey;
  label: string;
  shortLabel: string;
  icon: IconComponent;
  /// Official brand color, used for accents.
  colorPrimary: string;
}

/// Display order across the app: Claude, Codex, Antigravity. Icons are the
/// official colored brand marks stored in src/assets/icons/brands.
export const TOOLS: ToolMeta[] = [
  {
    key: "claude",
    label: "Claude Code",
    shortLabel: "C",
    icon: ClaudeCodeIcon,
    colorPrimary: "#D97757",
  },
  {
    key: "codex",
    label: "Codex",
    shortLabel: "X",
    icon: CodexIcon,
    colorPrimary: "#ffffff",
  },
  {
    key: "antigravity",
    label: "Antigravity",
    shortLabel: "A",
    icon: AntigravityIcon,
    colorPrimary: "#ffffff",
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

import claudeCodeIcon from "../../assets/icons/brands/claude-code.svg";
import { createSvgAssetIcon } from "../../components/SvgAssetIcon";
import type { CliAdapter } from "./types";

const ClaudeCodeIcon = createSvgAssetIcon(claudeCodeIcon);

export const claudeAdapter: CliAdapter = {
  key: "claude",
  label: "Claude Code",
  shortLabel: "CC",
  icon: ClaudeCodeIcon,
  terminalPaste: { controlV: "clipboard", windowsAltV: "escape-v" },
  latestStatusKind: "version",
  showCommandNotice: () => true,
  refreshLatestAfterExecution: () => false,
  displayExecutionStream: (_kind, stream) => stream,
};

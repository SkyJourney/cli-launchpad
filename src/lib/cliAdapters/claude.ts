import claudeCodeIcon from "../../assets/icons/brands/claude-code.svg";
import { createSvgAssetIcon } from "../../components/SvgAssetIcon";
import { hasUpdate } from "../format";
import type { CliAdapter } from "./types";

const ClaudeCodeIcon = createSvgAssetIcon(claudeCodeIcon);

export const claudeAdapter: CliAdapter = {
  key: "claude",
  label: "Claude Code",
  shortLabel: "CC",
  icon: ClaudeCodeIcon,
  colorPrimary: "#D97757",
  settingsActions: true,
  canManageSettings: () => true,
  terminalPaste: { controlV: "clipboard", windowsAltV: "escape-v" },
  latestStatusKind: "version",
  showCommandNotice: () => true,
  showManagementMessage: false,
  refreshLatestAfterExecution: () => false,
  displayExecutionStream: (_kind, stream) => stream,
  isManagedUpdateAllowed: () => true,
  getUpdateAvailability: (currentVersion, latest) =>
    latest ? hasUpdate(currentVersion, latest.latest) : null,
};

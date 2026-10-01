import codexIcon from "../../assets/icons/brands/codex.svg";
import { createSvgAssetIcon } from "../../components/SvgAssetIcon";
import { hasUpdate } from "../format";
import type { CliAdapter } from "./types";

const CodexIcon = createSvgAssetIcon(codexIcon);

export const codexAdapter: CliAdapter = {
  key: "codex",
  label: "Codex",
  shortLabel: "CDX",
  icon: CodexIcon,
  colorPrimary: "#ffffff",
  settingsActions: true,
  canManageSettings: () => true,
  terminalPaste: { controlV: "control-v", windowsAltV: "terminal" },
  latestStatusKind: "version",
  showCommandNotice: () => true,
  showManagementMessage: false,
  refreshLatestAfterExecution: () => false,
  displayExecutionStream: (_kind, stream) => stream,
  isManagedUpdateAllowed: () => true,
  getUpdateAvailability: (currentVersion, latest) =>
    latest ? hasUpdate(currentVersion, latest.latest) : null,
};

import antigravityIcon from "../../assets/icons/brands/antigravity.svg";
import { createSvgAssetIcon } from "../../components/SvgAssetIcon";
import { hasUpdate } from "../format";
import type { CliAdapter } from "./types";

const AntigravityIcon = createSvgAssetIcon(antigravityIcon);

export const antigravityAdapter: CliAdapter = {
  key: "antigravity",
  label: "Antigravity",
  shortLabel: "AGY",
  icon: AntigravityIcon,
  terminalPaste: { controlV: "clipboard", windowsAltV: "terminal" },
  latestStatusKind: "version",
  showCommandNotice: () => true,
  showManagementMessage: false,
  refreshLatestAfterExecution: () => false,
  displayExecutionStream: (_kind, stream) => stream,
  isManagedUpdateAllowed: () => true,
  getUpdateAvailability: (currentVersion, latest) =>
    latest ? hasUpdate(currentVersion, latest.latest) : null,
};

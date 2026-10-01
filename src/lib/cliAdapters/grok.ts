import grokIcon from "../../assets/icons/brands/grok.svg";
import { createSvgAssetIcon } from "../../components/SvgAssetIcon";
import type { ExecutionStream } from "../tauri";
import { hasUpdate } from "../format";
import type { CliAdapter } from "./types";

const GrokIcon = createSvgAssetIcon(grokIcon, true);

export const grokAdapter: CliAdapter = {
  key: "grok",
  label: "Grok Build",
  shortLabel: "GB",
  icon: GrokIcon,
  settingsActions: true,
  canManageSettings: () => true,
  terminalPaste: { controlV: "terminal", windowsAltV: "terminal" },
  latestStatusKind: "version",
  installEffects: {
    headingKey: "settings.grokInstallEffectsHeading",
    effectKeys: [
      "settings.grokInstallEffectPath",
      "settings.grokInstallEffectChannel",
      "settings.grokInstallEffectFiles",
      "settings.grokInstallEffectPathEnv",
      "settings.grokInstallEffectNetwork",
    ],
  },
  showCommandNotice: () => true,
  showManagementMessage: true,
  refreshLatestAfterExecution: () => true,
  displayExecutionStream: (kind, stream): ExecutionStream =>
    kind === "update" && stream === "stderr" ? "stdout" : stream,
  isManagedUpdateAllowed: (latest) => latest?.managedUpdateAllowed === true,
  getUpdateAvailability: (currentVersion, latest) =>
    latest ? hasUpdate(currentVersion, latest.latest) : null,
};

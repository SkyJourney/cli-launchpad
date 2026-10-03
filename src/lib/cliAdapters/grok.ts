import grokIcon from "../../assets/icons/brands/grok.svg";
import { createSvgAssetIcon } from "../../components/SvgAssetIcon";
import type { ExecutionStream } from "../tauri";
import { hasUpdate } from "../format";
import type { CliAdapter, CliPlatform } from "./types";

const GrokIcon = createSvgAssetIcon(grokIcon, true);

export const grokAdapter: CliAdapter = {
  key: "grok",
  label: "Grok Build",
  shortLabel: "GB",
  icon: GrokIcon,
  settingsActions: true,
  canManageSettings: (_platform: CliPlatform) => true,
  terminalPaste: { controlV: "terminal", windowsAltV: "terminal" },
  latestStatusKind: "version",
  installEffects: (platform) =>
    platform === "windows"
      ? {
          headingKey: "settings.grokInstallEffectsHeading",
          effectKeys: [
            "settings.grokInstallEffectPath",
            "settings.grokInstallEffectChannel",
            "settings.grokInstallEffectFiles",
            "settings.grokInstallEffectPathEnv",
            "settings.grokInstallEffectNetwork",
          ],
        }
      : {
          headingKey: "settings.grokPosixInstallEffectsHeading",
          effectKeys: [
            "settings.grokPosixInstallEffectPath",
            "settings.grokPosixInstallEffectFiles",
            "settings.grokPosixInstallEffectShell",
            "settings.grokPosixInstallEffectNetwork",
          ],
        },
  showCommandNotice: () => true,
  showManagementMessage: true,
  refreshLatestAfterExecution: () => true,
  displayExecutionStream: (_kind, stream): ExecutionStream =>
    stream === "stderr" ? "stdout" : stream,
  isManagedUpdateAllowed: (latest) => latest?.managedUpdateAllowed === true,
  getUpdateAvailability: (currentVersion, latest) =>
    latest ? hasUpdate(currentVersion, latest.latest) : null,
};

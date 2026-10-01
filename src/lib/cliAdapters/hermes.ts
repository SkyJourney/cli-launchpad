import { createElement } from "react";
import hermesAgentAvatar from "../../assets/icons/brands/hermesagent.webp";
import type { InstallKind } from "../tauri";
import type { CliAdapter } from "./types";

const HermesAgentIcon: CliAdapter["icon"] = ({ size = 24 }) =>
  createElement("img", {
    "aria-hidden": true,
    alt: "",
    height: size,
    src: hermesAgentAvatar,
    style: { display: "block", flex: "none" },
    width: size,
  });

export const hermesAdapter: CliAdapter = {
  key: "hermes",
  label: "Hermes Agent",
  shortLabel: "HA",
  icon: HermesAgentIcon,
  settingsActions: true,
  canManageSettings: (isWindows) => isWindows,
  terminalPaste: { controlV: "terminal", windowsAltV: "terminal" },
  latestStatusKind: "branch-update",
  installEffects: {
    headingKey: "settings.hermesInstallEffectsHeading",
    effectKeys: [
      "settings.hermesInstallEffectRuntime",
      "settings.hermesInstallEffectData",
      "settings.hermesInstallEffectPath",
      "settings.hermesInstallEffectNetwork",
    ],
  },
  showCommandNotice: (kind: InstallKind) => kind !== "update",
  showManagementMessage: true,
  refreshLatestAfterExecution: (kind: InstallKind) => kind === "update",
  displayExecutionStream: (_kind, stream) => stream,
  isManagedUpdateAllowed: (latest) => latest?.managedUpdateAllowed === true,
  getUpdateAvailability: (_currentVersion, latest) =>
    latest?.updateAvailable ?? null,
};

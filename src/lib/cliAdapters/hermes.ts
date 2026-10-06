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
  terminalPaste: { controlV: "terminal", windowsAltV: "terminal" },
  latestStatusKind: "branch-update",
  installEffects: (platform) =>
    platform === "windows"
      ? {
          headingKey: "settings.hermesInstallEffectsHeading",
          effectKeys: [
            "settings.hermesInstallEffectRuntime",
            "settings.hermesInstallEffectData",
            "settings.hermesInstallEffectPath",
            "settings.hermesInstallEffectNetwork",
          ],
        }
      : platform === "macos" || platform === "linux"
        ? {
            headingKey: "settings.hermesPosixInstallEffectsHeading",
            effectKeys: [
              "settings.hermesPosixInstallEffectLayout",
              "settings.hermesPosixInstallEffectRuntime",
              "settings.hermesPosixInstallEffectShell",
              "settings.hermesPosixInstallEffectOptions",
              "settings.hermesPosixInstallEffectSetup",
              "settings.hermesPosixInstallEffectNetwork",
            ],
          }
        : undefined,
  showCommandNotice: (kind: InstallKind) => kind !== "update",
  refreshLatestAfterExecution: (kind: InstallKind) => kind === "update",
  displayExecutionStream: (_kind, stream) => stream,
};

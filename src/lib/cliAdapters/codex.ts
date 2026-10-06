import codexIcon from "../../assets/icons/brands/codex.svg";
import { createSvgAssetIcon } from "../../components/SvgAssetIcon";
import type { CliAdapter } from "./types";

const CodexIcon = createSvgAssetIcon(codexIcon);

export const codexAdapter: CliAdapter = {
  key: "codex",
  label: "Codex",
  shortLabel: "CDX",
  icon: CodexIcon,
  terminalPaste: { controlV: "control-v", windowsAltV: "terminal" },
  latestStatusKind: "version",
  showCommandNotice: () => true,
  refreshLatestAfterExecution: () => false,
  displayExecutionStream: (_kind, stream) => stream,
};

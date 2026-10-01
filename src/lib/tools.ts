import { antigravityAdapter } from "./cliAdapters/antigravity";
import { claudeAdapter } from "./cliAdapters/claude";
import { codexAdapter } from "./cliAdapters/codex";
import { grokAdapter } from "./cliAdapters/grok";
import { hermesAdapter } from "./cliAdapters/hermes";
import type { CliAdapter } from "./cliAdapters/types";
import type { LatestVersion, ToolKey } from "./tauri";

export type ToolMeta = CliAdapter;

/// Display order across the app: Claude, Codex, Antigravity, Grok Build, Hermes Agent.
const CLI_ADAPTERS: Record<ToolKey, ToolMeta> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  antigravity: antigravityAdapter,
  grok: grokAdapter,
  hermes: hermesAdapter,
};

export const TOOLS: ToolMeta[] = [
  CLI_ADAPTERS.claude,
  CLI_ADAPTERS.codex,
  CLI_ADAPTERS.antigravity,
  CLI_ADAPTERS.grok,
  CLI_ADAPTERS.hermes,
];

export function getCliAdapter(toolKey: ToolKey): CliAdapter {
  return CLI_ADAPTERS[toolKey];
}

export function getTerminalTitleLabel(toolKey: ToolKey): string {
  return getCliAdapter(toolKey).shortLabel;
}

export function isManagedUpdateAllowed(
  toolKey: ToolKey,
  latest: Pick<LatestVersion, "managedUpdateAllowed"> | undefined,
): boolean {
  return getCliAdapter(toolKey).isManagedUpdateAllowed(latest);
}

export function getLatestUpdateAvailability(
  toolKey: ToolKey,
  currentVersion: string | null,
  latest: LatestVersion | undefined,
): boolean | null {
  return getCliAdapter(toolKey).getUpdateAvailability(currentVersion, latest);
}

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

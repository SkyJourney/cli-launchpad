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

export const TOOLS: ToolMeta[] = Object.values(CLI_ADAPTERS);

export function getCliAdapter(toolKey: ToolKey): CliAdapter;
export function getCliAdapter(toolKey: string): CliAdapter | undefined;
export function getCliAdapter(toolKey: string): CliAdapter | undefined {
  return CLI_ADAPTERS[toolKey as ToolKey];
}

export function getTerminalTitleLabel(toolKey: ToolKey): string {
  return getCliAdapter(toolKey).shortLabel;
}

export function isManagedUpdateAllowed(
  latest: Pick<LatestVersion, "managedUpdate"> | undefined,
): boolean {
  return latest?.managedUpdate.status === "allowed";
}

export function getLatestUpdateAvailability(
  latest: Pick<LatestVersion, "updateAvailability"> | undefined,
): NonNullable<LatestVersion["updateAvailability"]> {
  return latest?.updateAvailability ?? "unknown";
}

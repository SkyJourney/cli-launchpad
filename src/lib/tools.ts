import { createRef, type RefObject } from "react";
import { CLI_ADAPTERS_BY_KEY } from "../generated/cliAdapters";
import type { CliAdapter } from "./cliAdapters/types";
import type { LatestVersion, ToolKey } from "./tauri";

export type ToolMeta = CliAdapter;

// 适配器按契约顺序排列（Claude、Codex、Antigravity、Grok Build、Hermes Agent）；
// 清单由生成器从契约与适配器模块得到，缺失或多余的适配器在编译期即失败。
const CLI_ADAPTERS: Record<ToolKey, ToolMeta> = CLI_ADAPTERS_BY_KEY;

export const TOOLS: ToolMeta[] = Object.values(CLI_ADAPTERS);

export function getCliAdapter(toolKey: ToolKey): CliAdapter;
export function getCliAdapter(toolKey: string): CliAdapter | undefined;
export function getCliAdapter(toolKey: string): CliAdapter | undefined {
  return CLI_ADAPTERS[toolKey as ToolKey];
}

export function createToolAnchorRefs(): Record<
  ToolKey,
  RefObject<HTMLDivElement | null>
> {
  return Object.fromEntries(
    TOOLS.map((tool) => [tool.key, createRef<HTMLDivElement>()]),
  ) as Record<ToolKey, RefObject<HTMLDivElement | null>>;
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

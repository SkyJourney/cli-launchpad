import { createRef, type RefObject } from "react";
import { REGISTERED_TOOL_KEYS } from "../generated/toolKeys";
import type { CliAdapter } from "./cliAdapters/types";
import type { LatestVersion, ToolKey } from "./tauri";

export type ToolMeta = CliAdapter;

// 每个 cliAdapters 模块导出自己的适配器；新增工具只需新增模块，不改本文件。
const ADAPTER_MODULES = import.meta.glob<Record<string, unknown>>(
  "./cliAdapters/*.ts",
  { eager: true },
);

function isCliAdapter(value: unknown): value is CliAdapter {
  return (
    typeof value === "object" &&
    value !== null &&
    "key" in value &&
    "label" in value
  );
}

const adaptersByKey = new Map<string, CliAdapter>();
for (const module of Object.values(ADAPTER_MODULES)) {
  for (const value of Object.values(module)) {
    if (!isCliAdapter(value)) continue;
    if (adaptersByKey.has(value.key)) {
      throw new Error(`CLI 适配器重复登记: ${value.key}`);
    }
    adaptersByKey.set(value.key, value);
  }
}

/// Display order across the app follows the contract: Claude, Codex, Antigravity, Grok Build,
/// Hermes Agent. A contract tool without an adapter, or an adapter outside the contract, is a bug.
const CLI_ADAPTERS = Object.fromEntries(
  REGISTERED_TOOL_KEYS.map((key) => {
    const adapter = adaptersByKey.get(key);
    if (!adapter) throw new Error(`契约工具缺少 CLI 适配器: ${key}`);
    return [key, adapter];
  }),
) as Record<ToolKey, ToolMeta>;
if (adaptersByKey.size !== REGISTERED_TOOL_KEYS.length) {
  const unknown = [...adaptersByKey.keys()].filter(
    (key) => !(REGISTERED_TOOL_KEYS as readonly string[]).includes(key),
  );
  throw new Error(`CLI 适配器不在契约中: ${unknown.join(", ")}`);
}

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

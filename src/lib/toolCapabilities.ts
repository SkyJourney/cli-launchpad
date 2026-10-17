import contract from "../../contracts/tool-capabilities.json";
import type { ToolKey } from "./tauri";

export type UpdateSemantics = "version" | "branch";

export type ManagedUpdatePolicy =
  | { mode: "always" }
  | { mode: "sourceVerified"; deniedReasonKey: string };

export interface ProviderCapabilities {
  history: boolean;
  resume: boolean;
  updateSemantics: UpdateSemantics;
  managedUpdate: ManagedUpdatePolicy;
  installEffectsKey: string | null;
}

export interface ProviderDescriptor {
  toolKey: ToolKey;
  apiVersion: number;
  capabilities: ProviderCapabilities;
}

// JSON 模块会把字面量推断为 string，这里的形状由 Rust 测试 C-1 与 TS 测试 TC-1 至 TC-3 守护。
const descriptors = contract.items as unknown as ProviderDescriptor[];

export function listProviderDescriptors(): readonly ProviderDescriptor[] {
  return descriptors;
}

export function getProviderDescriptor(toolKey: ToolKey): ProviderDescriptor {
  const descriptor = descriptors.find((item) => item.toolKey === toolKey);
  if (!descriptor) throw new Error(`未登记的 Provider 能力：${toolKey}`);
  return descriptor;
}

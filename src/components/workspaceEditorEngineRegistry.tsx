import type { ComponentType } from "react";
import { createRegistry } from "../lib/createRegistry";
import { WORKSPACE_EDITOR_ENGINE_API_VERSION } from "../lib/extensionApiVersions";
import type { ThemeId } from "../lib/themes";
export interface WorkspaceEditorEngineProps {
  documentKey: string;
  value: string;
  relativePath: string;
  modelUri: string;
  theme: ThemeId;
  readOnly: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
}

export interface WorkspaceEditorEngine {
  id: string;
  apiVersion: 1;
  View: ComponentType<WorkspaceEditorEngineProps>;
  releaseDocument: (documentKey: string) => void | Promise<void>;
}

export const defaultEngineId = "core.monaco";

const registry = createRegistry<WorkspaceEditorEngine>({
  name: "workspaceEditorEngine",
  supportedApiVersions: [WORKSPACE_EDITOR_ENGINE_API_VERSION],
  messages: {
    emptyId: "编辑器引擎 ID 不能为空",
    unsupportedApiVersion: (apiVersion) =>
      `不支持编辑器引擎 API 版本: ${apiVersion}`,
    duplicateId: (id) => `编辑器引擎 ID 已注册: ${id}`,
  },
});

export function registerWorkspaceEditorEngine(
  engine: WorkspaceEditorEngine,
): () => void {
  return registry.register(engine);
}

export function getWorkspaceEditorEngine(id: string): WorkspaceEditorEngine {
  const engine = registry.get(id);
  if (!engine) throw new Error(`未注册编辑器引擎: ${id}`);
  return engine;
}

export function resolveEditorEngine(
  preferredId?: string,
): WorkspaceEditorEngine | undefined {
  return (
    (preferredId ? registry.get(preferredId) : undefined) ??
    registry.get(defaultEngineId)
  );
}

export function listWorkspaceEditorEngines(): readonly WorkspaceEditorEngine[] {
  return registry.list();
}

export function getWorkspaceEditorEngineRevision(): number {
  return registry.revision();
}

export function subscribeWorkspaceEditorEngines(listener: () => void) {
  return registry.subscribe(listener);
}

const engineUse = new Map<string, string>();

/** 记录某个文档实际使用的编辑器引擎；`dispose` 时据此释放。 */
export function recordEditorEngineUse(
  documentKey: string,
  engineId: string,
): void {
  engineUse.set(documentKey, engineId);
}

export function recordedEditorEngineId(
  documentKey: string,
): string | undefined {
  return engineUse.get(documentKey);
}

/**
 * 释放文档在编辑器引擎里的资源：有记录则释放记录的引擎（该引擎已被注销则无事可做），
 * 没有记录则回退默认引擎，保持记录功能加入之前的行为。
 */
export function releaseEditorDocument(
  documentKey: string,
): void | Promise<void> {
  const recorded = engineUse.get(documentKey);
  engineUse.delete(documentKey);
  if (recorded !== undefined) {
    return registry.get(recorded)?.releaseDocument(documentKey);
  }
  return resolveEditorEngine()?.releaseDocument(documentKey);
}

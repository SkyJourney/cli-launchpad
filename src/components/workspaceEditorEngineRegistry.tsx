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

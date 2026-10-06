import type { ComponentType } from "react";
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

const engines = new Map<string, WorkspaceEditorEngine>();
const listeners = new Set<() => void>();
let revision = 0;

function notifyChanged() {
  revision += 1;
  listeners.forEach((listener) => listener());
}

export function registerWorkspaceEditorEngine(
  engine: WorkspaceEditorEngine,
): () => void {
  if (!engine.id.trim()) throw new Error("编辑器引擎 ID 不能为空");
  if (engine.apiVersion !== 1) {
    throw new Error(`不支持编辑器引擎 API 版本: ${engine.apiVersion}`);
  }
  if (engines.has(engine.id)) {
    throw new Error(`编辑器引擎 ID 已注册: ${engine.id}`);
  }
  engines.set(engine.id, engine);
  notifyChanged();
  return () => {
    if (engines.get(engine.id) !== engine) return;
    engines.delete(engine.id);
    notifyChanged();
  };
}

export function getWorkspaceEditorEngine(id: string): WorkspaceEditorEngine {
  const engine = engines.get(id);
  if (!engine) throw new Error(`未注册编辑器引擎: ${id}`);
  return engine;
}

export function resolveEditorEngine(
  preferredId?: string,
): WorkspaceEditorEngine | undefined {
  return (
    (preferredId ? engines.get(preferredId) : undefined) ??
    engines.get(defaultEngineId)
  );
}

export function getWorkspaceEditorEngineRevision(): number {
  return revision;
}

export function subscribeWorkspaceEditorEngines(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

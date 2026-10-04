import { useSyncExternalStore } from "react";
import type { WorkspaceEditorEngineProps } from "./workspaceEditorEngineRegistry";
import {
  getWorkspaceEditorEngine,
  getWorkspaceEditorEngineRevision,
  subscribeWorkspaceEditorEngines,
} from "./workspaceEditorEngineRegistry";
import { registerBuiltinWorkspaceEditorEngines } from "./workspaceEditorEngines/builtins";

const unregisterBuiltinEngine = registerBuiltinWorkspaceEditorEngines();

export { registerWorkspaceEditorEngine } from "./workspaceEditorEngineRegistry";

export function WorkspaceEditorSurface(props: WorkspaceEditorEngineProps) {
  useSyncExternalStore(
    subscribeWorkspaceEditorEngines,
    getWorkspaceEditorEngineRevision,
    getWorkspaceEditorEngineRevision,
  );
  const Engine = getWorkspaceEditorEngine("core.monaco").View;
  return <Engine {...props} />;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => unregisterBuiltinEngine());
}

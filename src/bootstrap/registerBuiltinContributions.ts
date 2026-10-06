import { registerBuiltinWorkspaceContentAdapters } from "../components/workspaceContentAdapters/builtins";
import { registerBuiltinWorkspaceEditorEngines } from "../components/workspaceEditorEngines/builtins";

let unregisterContributions: (() => void) | undefined;

export function registerBuiltinContributions(): () => void {
  if (unregisterContributions) return unregisterContributions;

  const cleanup: Array<() => void> = [];
  try {
    cleanup.push(registerBuiltinWorkspaceContentAdapters());
    cleanup.push(registerBuiltinWorkspaceEditorEngines());
  } catch (error) {
    cleanup.reverse().forEach((unregister) => unregister());
    throw error;
  }

  const unregister = () => {
    if (unregisterContributions !== unregister) return;
    unregisterContributions = undefined;
    cleanup.reverse().forEach((dispose) => dispose());
  };
  unregisterContributions = unregister;
  return unregister;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => unregisterContributions?.());
}

import { registerBuiltinWorkspaceContentAdapters } from "../components/workspaceContentAdapters/builtins";
import { registerBuiltinWorkspaceEditorEngines } from "../components/workspaceEditorEngines/builtins";

let unregisterContributions: (() => void) | undefined;

export function registerBuiltinContributions(): () => void {
  if (unregisterContributions) return unregisterContributions;

  // 每个注册函数内部已逐项隔离被拒绝的贡献（registerContributionSafely），
  // 这里不再整体回滚：一项失败不影响其余贡献。
  const cleanup: Array<() => void> = [
    registerBuiltinWorkspaceContentAdapters(),
    registerBuiltinWorkspaceEditorEngines(),
  ];

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

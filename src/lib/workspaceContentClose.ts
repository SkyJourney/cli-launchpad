export interface WorkspaceContentBeforeCloseContext {
  isDirty: boolean;
  confirmDiscard: () => boolean;
}

export type WorkspaceContentBeforeCloseHook = (
  context: WorkspaceContentBeforeCloseContext,
) => boolean;

export type WorkspaceContentWindowBeforeCloseHook = () => boolean;

export function shouldCloseWorkspaceContent(
  hook: WorkspaceContentBeforeCloseHook | undefined,
  context: WorkspaceContentBeforeCloseContext,
): boolean {
  return hook ? hook(context) : true;
}

export function requestWorkspaceContentClose(
  hook: WorkspaceContentBeforeCloseHook | undefined,
  context: WorkspaceContentBeforeCloseContext,
  close: () => void,
): boolean {
  if (!shouldCloseWorkspaceContent(hook, context)) return false;
  close();
  return true;
}

export function shouldCloseWorkspaceWindow(
  hook: WorkspaceContentWindowBeforeCloseHook | undefined,
): boolean {
  return hook ? hook() : true;
}

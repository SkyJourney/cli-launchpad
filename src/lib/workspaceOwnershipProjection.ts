import {
  hasWorkspaceContent,
  listWorkspacePanes,
  type WorkspaceNode,
} from "./ptyWorkspaceLayout";
import type { WorkspacePaneContentRef } from "./tauri";
import { workspaceContentKey } from "./workspaceContentKey";
import type { WorkspaceContentLifecycleState } from "./workspaceContentLifecycle";

export { canChangeWorkspaceContentPane as canChangePane } from "./workspaceContentLifecycle";

type MaybeState = WorkspaceContentLifecycleState | undefined;

/** 正在交接（源或目标之一尚未接管）：`detaching` 与 `returning`。 */
export function isHandoffActive(state: MaybeState): boolean {
  return state?.phase === "detaching" || state?.phase === "returning";
}

/** 内容此刻归窗口占有：交接中、已分离，以及窗口所有者的 `closing`。 */
export function isWindowOwned(state: MaybeState): boolean {
  if (!state) return false;
  if (
    state.phase === "detaching" ||
    state.phase === "detached" ||
    state.phase === "returning"
  ) {
    return true;
  }
  return state.phase === "closing" && state.owner.kind === "window";
}

export interface OwnerWindow {
  windowLabel: string;
  windowToken: string | null;
}

/** 已接管内容的窗口；`detaching`、pane 所有者的 `closing`、`attached`、`disposed` 与 `undefined` 为 null。 */
export function ownerWindowOf(state: MaybeState): OwnerWindow | null {
  if (!state) return null;
  if (state.phase === "detached") {
    return {
      windowLabel: state.owner.windowLabel,
      windowToken: state.windowToken,
    };
  }
  if (state.phase === "returning") {
    return {
      windowLabel: state.source.windowLabel,
      windowToken: state.windowToken,
    };
  }
  if (state.phase === "closing" && state.owner.kind === "window") {
    return {
      windowLabel: state.owner.windowLabel,
      windowToken: state.windowToken ?? null,
    };
  }
  return null;
}

/**
 * 从“窗口占有的内容”里挑出树之外、应当持久化为 `detachedContents` 的那些。
 * `detaching` 阶段的内容仍留在源 pane 的树中，所以被“不在树中”过滤掉，不会重复。
 * 按 `workspaceContentKey` 去重并保持输入顺序，返回新对象。
 */
export function listPersistedDetachedContents(
  windowOwned: readonly WorkspacePaneContentRef[],
  tree: WorkspaceNode,
): WorkspacePaneContentRef[] {
  const panes = listWorkspacePanes(tree);
  const seen = new Set<string>();
  const result: WorkspacePaneContentRef[] = [];
  for (const content of windowOwned) {
    if (panes.some((pane) => hasWorkspaceContent(pane, content))) continue;
    const key = workspaceContentKey(content);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...content });
  }
  return result;
}

/**
 * 投影从不修改树；它返回树之外应当持久化为 detachedContents 的内容。
 * 主报告 S3G-A01 草案曾设想同时返回 tree，本实现不返回，因为树的权威来源是 pane 视图。
 */
export function projectPersistedOwnership(
  tree: WorkspaceNode,
  states: readonly WorkspaceContentLifecycleState[],
): { detachedContents: WorkspacePaneContentRef[] } {
  return {
    detachedContents: listPersistedDetachedContents(
      states.filter(isWindowOwned).map((state) => state.content),
      tree,
    ),
  };
}

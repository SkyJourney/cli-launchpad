import type { WorkspacePaneContentRef } from "../../lib/tauri";
import { isWorkspaceApplyStateCurrent } from "../../lib/workspaceLayoutPersistence";
import type { HostSnapshot } from "../host/workspaceHostStore";

/** 应用预设开始时记录的状态：计划返回前若变化，应用必须失败。 */
export function captureApplyState(
  live: HostSnapshot,
  protectedContents: WorkspacePaneContentRef[],
) {
  return {
    tree: live.tree,
    slots: live.slots,
    focusedPaneId: live.focusedPaneId,
    detachedContents: protectedContents,
  };
}

/** 与开始时记录的状态比较；只读。 */
export function applyStateStillCurrent(
  expected: ReturnType<typeof captureApplyState>,
  live: HostSnapshot,
  detachedContents: WorkspacePaneContentRef[],
): boolean {
  return isWorkspaceApplyStateCurrent(expected, {
    tree: live.tree,
    slots: live.slots,
    focusedPaneId: live.focusedPaneId,
    detachedContents,
  });
}

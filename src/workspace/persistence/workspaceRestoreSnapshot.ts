import type { WorkspaceLayoutDocument } from "../../lib/tauri";
import {
  markWorkspaceSlotsRestored,
  rehomeDetachedWorkspaceContents,
  removeEndedWorkspaceSlots,
  restoreWorkspaceRuntimeSnapshot,
} from "../../lib/workspaceLayoutPersistence";
import type { HostRuntimeSteps } from "../host/resetHostRuntime";

/** 由已读取的布局还原运行期快照：只读计算，不做任何副作用。 */
export function restoreLayoutSnapshot(
  layout: WorkspaceLayoutDocument,
  slotStates: Parameters<typeof markWorkspaceSlotsRestored>[1],
) {
  const restored = rehomeDetachedWorkspaceContents(
    restoreWorkspaceRuntimeSnapshot(layout),
  );
  return removeEndedWorkspaceSlots({
    ...restored,
    slots: markWorkspaceSlotsRestored(restored.slots, slotStates),
  });
}

/**
 * 包装协调器重建步骤：失败只记录，不中断其余步骤；调用方在重置完成后再决定是否进入 loadFailed。
 * 与原实现一致：执行完其余步骤后进入 loadFailed，不发布半更新的状态。
 */
export function guardRebuildCoordinator(steps: HostRuntimeSteps) {
  const failure: { failed: boolean; error: unknown } = {
    failed: false,
    error: undefined,
  };
  const rebuildCoordinator = steps.rebuildCoordinator;
  return {
    failure,
    steps: {
      ...steps,
      rebuildCoordinator: () => {
        try {
          rebuildCoordinator();
        } catch (error) {
          failure.failed = true;
          failure.error = error;
        }
      },
    },
  };
}

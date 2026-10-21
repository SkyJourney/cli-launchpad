import { listWorkspacePanes } from "../../lib/ptyWorkspaceLayout";
import type { HostSnapshot } from "./workspaceHostStore";

export interface ActiveFileLoaderDeps {
  getSnapshot: () => HostSnapshot;
  load: (documentId: string) => Promise<void>;
  onError: (reason: unknown) => void;
}

export interface ActiveFileLoader {
  /** 确保每个窗格的活动文件都有 buffer；只能由显式入口调用（m6-115）。 */
  ensure: () => void;
  /** 布局整体替换（水合、重置）后清除失败记录，使新布局中的文件可以重试。 */
  reset: () => void;
}

/** 每个窗格的活动文件 id（只含文件内容）。 */
export function activeFileIdsOf(snapshot: HostSnapshot): string[] {
  return listWorkspacePanes(snapshot.tree).flatMap((pane) => {
    const content = pane.activeContent;
    return content && "documentId" in content ? [content.documentId] : [];
  });
}

/**
 * 替代 WorkspacePaneView 里的自动加载效果：不再由渲染驱动，而是由执行器提交之后、布局应用之后、
 * 关闭批次之后等显式入口调用 `ensure()`。
 * 失败的文件记录在 failed 中，直到它不再是任何窗格的活动文件，才允许再次尝试（不无限重试）。
 */
export function createActiveFileLoader(
  deps: ActiveFileLoaderDeps,
): ActiveFileLoader {
  const inFlight = new Set<string>();
  const failed = new Set<string>();
  return {
    ensure() {
      const snapshot = deps.getSnapshot();
      const active = new Set(activeFileIdsOf(snapshot));
      for (const documentId of [...failed]) {
        if (!active.has(documentId)) failed.delete(documentId);
      }
      for (const documentId of active) {
        if (
          snapshot.buffers[documentId] ||
          inFlight.has(documentId) ||
          failed.has(documentId)
        ) {
          continue;
        }
        inFlight.add(documentId);
        deps
          .load(documentId)
          .catch((reason: unknown) => {
            failed.add(documentId);
            deps.onError(reason);
          })
          .finally(() => inFlight.delete(documentId));
      }
    },
    reset() {
      failed.clear();
    },
  };
}

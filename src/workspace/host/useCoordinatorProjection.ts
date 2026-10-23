import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { WorkspaceContentCoordinator } from "../../lib/workspaceContentCoordinator";
import type { WorkspacePaneContentRef } from "../../lib/tauri";
import { contentOwnsPty, workspaceContentKey } from "../../lib/workspaceContentKey";

export interface CoordinatorProjection {
  revision: number;
  /** Contents held by a detached window. */
  detachedWindowContents: WorkspacePaneContentRef[];
  /** Whether a content is held by a detached window. */
  isDetachedContent: (content: WorkspacePaneContentRef) => boolean;
  /** Whether a content is mid-handoff (detaching or returning). */
  isHandoffContent: (content: WorkspacePaneContentRef) => boolean;
  /** Whether any detached window owns a PTY session. */
  hasDetachedSessions: boolean;
  closingContentKeys: Set<string>;
}

/** 内容协调器的只读投影：订阅修订号，并派生窗口持有、交接中与关闭中的集合。 */
export function useCoordinatorProjection(
  coordinator: WorkspaceContentCoordinator,
): CoordinatorProjection {
  const subscribeContentCoordinator = useCallback(
    (listener: () => void) => coordinator.subscribe(listener),
    [coordinator],
  );
  const getContentCoordinatorRevision = useCallback(
    () => coordinator.getRevision(),
    [coordinator],
  );
  const contentCoordinatorRevision = useSyncExternalStore(
    subscribeContentCoordinator,
    getContentCoordinatorRevision,
    getContentCoordinatorRevision,
  );
  const detachedWindowContents = useMemo(
    () => coordinator.listWindowOwned(),
    [coordinator, contentCoordinatorRevision],
  );
  const detachedKeys = useMemo(
    () => new Set(detachedWindowContents.map(workspaceContentKey)),
    [detachedWindowContents],
  );
  const handoffKeys = useMemo(
    () =>
      new Set(
        coordinator
          .listInPhases("detaching", "returning")
          .map(workspaceContentKey),
      ),
    [coordinator, contentCoordinatorRevision],
  );
  const isDetachedContent = useCallback(
    (content: WorkspacePaneContentRef) =>
      detachedKeys.has(workspaceContentKey(content)),
    [detachedKeys],
  );
  const isHandoffContent = useCallback(
    (content: WorkspacePaneContentRef) =>
      handoffKeys.has(workspaceContentKey(content)),
    [handoffKeys],
  );
  const hasDetachedSessions = useMemo(
    () => detachedWindowContents.some(contentOwnsPty),
    [detachedWindowContents],
  );
  const closingContentKeys = useMemo(
    () =>
      new Set(
        coordinator
          .listInPhases("closing")
          .filter(contentOwnsPty)
          .map(workspaceContentKey),
      ),
    [coordinator, contentCoordinatorRevision],
  );
  return {
    revision: contentCoordinatorRevision,
    detachedWindowContents,
    isDetachedContent,
    isHandoffContent,
    hasDetachedSessions,
    closingContentKeys,
  };
}

import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { WorkspaceContentCoordinator } from "../../lib/workspaceContentCoordinator";
import type { WorkspacePaneContentRef } from "../../lib/tauri";
import { workspaceContentKey } from "../../lib/workspaceContentKey";

export interface CoordinatorProjection {
  revision: number;
  detachedWindowContents: WorkspacePaneContentRef[];
  detachedFileIds: Set<string>;
  detachedInstanceIds: Set<string>;
  handoffFileIds: Set<string>;
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
  const detachedFileIds = useMemo(
    () =>
      new Set(
        detachedWindowContents.flatMap((content) =>
          content.kind === "file" ? [content.documentId] : [],
        ),
      ),
    [detachedWindowContents],
  );
  const detachedInstanceIds = useMemo(
    () =>
      new Set(
        detachedWindowContents.flatMap((content) =>
          content.kind === "pty" ? [content.slotId] : [],
        ),
      ),
    [detachedWindowContents],
  );
  const handoffFileIds = useMemo(
    () =>
      new Set(
        coordinator
          .listInPhases("detaching", "returning")
          .flatMap((content) =>
            content.kind === "file" ? [content.documentId] : [],
          ),
      ),
    [coordinator, contentCoordinatorRevision],
  );
  const closingContentKeys = useMemo(
    () =>
      new Set(
        coordinator
          .listInPhases("closing")
          .filter((content) => content.kind === "pty")
          .map(workspaceContentKey),
      ),
    [coordinator, contentCoordinatorRevision],
  );
  return {
    revision: contentCoordinatorRevision,
    detachedWindowContents,
    detachedFileIds,
    detachedInstanceIds,
    handoffFileIds,
    closingContentKeys,
  };
}

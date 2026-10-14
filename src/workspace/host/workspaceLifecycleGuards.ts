import { collectAppExitImpacts } from "../../lib/appExitImpacts";
import type { PtySession } from "../../lib/tauri";
import type { WorkspaceContentCoordinator } from "../../lib/workspaceContentCoordinator";
import { workspaceContentKey } from "../../lib/workspaceContentKey";
import { isWorkspaceFileBufferNewer } from "../../lib/workspaceFileBuffer";
import { hasWorkspaceDataRestoreBlockers } from "../../lib/workspaceRestorePolicy";
import type { WorkspacePersistence } from "../persistence/workspacePersistence";
import { requestFileWindowFlush } from "../windows/protocolHandlers.file";
import type {
  ContentWindowDeps,
  ContentWindowOrchestrator,
} from "../windows/contentWindowOrchestrator";
import type { WorkspaceCommands } from "./workspaceContexts";
import type { HostSnapshot, WorkspaceHostStore } from "./workspaceHostStore";

export interface WorkspaceLifecycleGuardsDeps {
  store: WorkspaceHostStore;
  getCoordinator: () => WorkspaceContentCoordinator;
  orchestrator: ContentWindowOrchestrator;
  persistence: WorkspacePersistence;
  mergeFileBuffers: ContentWindowDeps["mergeFileBuffers"];
  waitForAllFileSaves: () => Promise<void>;
  runningPtySessions: (live: HostSnapshot) => PtySession[];
  runningPtyCountIn: (live: HostSnapshot, directoryId: number) => number;
}

export type WorkspaceLifecycleGuards = Pick<
  WorkspaceCommands,
  | "collectExitImpacts"
  | "getBackupRestoreBlockers"
  | "getDirectoryRemovalBlockers"
  | "cancelBackupRestore"
>;

/** Builds deps whose members always read the newest deps stored in the ref (R-FE-1). */
export function latestGuardDeps(
  ref: { current: WorkspaceLifecycleGuardsDeps | null },
  store: WorkspaceHostStore,
): WorkspaceLifecycleGuardsDeps {
  const current = (): WorkspaceLifecycleGuardsDeps => {
    if (!ref.current) throw new Error("lifecycle guard deps are not ready");
    return ref.current;
  };
  return {
    store,
    getCoordinator: () => current().getCoordinator(),
    get orchestrator() {
      return current().orchestrator;
    },
    get persistence() {
      return current().persistence;
    },
    mergeFileBuffers: (entries, reason) =>
      current().mergeFileBuffers(entries, reason),
    waitForAllFileSaves: () => current().waitForAllFileSaves(),
    runningPtySessions: (live) => current().runningPtySessions(live),
    runningPtyCountIn: (live, directoryId) =>
      current().runningPtyCountIn(live, directoryId),
  };
}

/** 退出、数据恢复与目录移除的守卫：创建时没有副作用，依赖在调用时读取。 */
export function createWorkspaceLifecycleGuards(
  deps: WorkspaceLifecycleGuardsDeps,
): WorkspaceLifecycleGuards {
  const { store } = deps;

  const collectExitImpacts = async (ptyCount: number) => {
    const managedWindows = new Map(
      deps.orchestrator
        .listManagedFileWindows()
        .map((managed) => [managed.documentId, managed] as const),
    );

    const flushResults = await Promise.all(
      [...managedWindows.values()].map(async (managed) => ({
        managed,
        response: await requestFileWindowFlush(deps.orchestrator, managed),
      })),
    );
    const uncertainDocumentIds: string[] = [];
    let nextBuffers = store.getLive().buffers;
    for (const { managed, response } of flushResults) {
      const currentDocument = store
        .getLive()
        .documents.find((document) => document.id === managed.documentId);
      if (
        !response ||
        !currentDocument ||
        response.fileDocument.directoryId !== currentDocument.directoryId ||
        response.fileDocument.directoryPath !== currentDocument.directoryPath ||
        response.fileDocument.relativePath !== currentDocument.relativePath
      ) {
        uncertainDocumentIds.push(managed.documentId);
        continue;
      }
      const currentBuffer = nextBuffers[managed.documentId];
      if (isWorkspaceFileBufferNewer(response.fileBuffer, currentBuffer)) {
        if (nextBuffers === store.getLive().buffers) {
          nextBuffers = { ...store.getLive().buffers };
        }
        nextBuffers[managed.documentId] = response.fileBuffer;
      }
    }
    if (nextBuffers !== store.getLive().buffers) {
      deps.mergeFileBuffers(nextBuffers, "collectExitImpacts:buffers");
    }

    return collectAppExitImpacts({
      ptyCount,
      documents: store.getLive().documents,
      buffers: store.getLive().buffers,
      uncertainDocumentIds,
    });
  };

  const getBackupRestoreBlockers = async () => {
    deps.persistence.restoreLatch.active = true;
    try {
      await deps.waitForAllFileSaves();
      await deps.persistence.flush();

      const runningPtyCount = deps.runningPtySessions(store.getLive()).length;
      const impacts = await collectExitImpacts(runningPtyCount);
      const detachedWindowIdentities = new Set(
        deps.getCoordinator().listWindowOwned().map(workspaceContentKey),
      );

      const blockers = {
        runningPtyCount: impacts.ptyCount,
        dirtyFileCount: impacts.dirtyFiles.length,
        detachedWindowCount: detachedWindowIdentities.size,
      };
      if (hasWorkspaceDataRestoreBlockers(blockers)) {
        deps.persistence.restoreLatch.active = false;
      }
      return blockers;
    } catch (reason) {
      deps.persistence.restoreLatch.active = false;
      throw reason;
    }
  };

  const getDirectoryRemovalBlockers = (directoryId: number) => {
    return {
      openFileCount: store
        .getLive()
        .documents.filter((document) => document.directoryId === directoryId)
        .length,
      runningPtyCount: deps.runningPtyCountIn(store.getLive(), directoryId),
    };
  };

  const cancelBackupRestore = () => {
    // 恢复请求成功时不在这里解冻：必须等 workspace-data-restored 触发
    // rehydrateWorkspace，否则旧内存布局会覆盖刚恢复的布局（FE-NEW-04）。
    // 失败路径使用 resumeAfterFailedRestore。
  };

  return {
    collectExitImpacts,
    getBackupRestoreBlockers,
    getDirectoryRemovalBlockers,
    cancelBackupRestore,
  };
}

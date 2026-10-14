import { useCallback, useMemo, useRef } from "react";
import { toast } from "sonner";
import { reportWindowSyncFailure } from "../../lib/windowSyncDiagnostics";
import {
  setWorkspaceSplitRatio,
  type SplitDirection,
} from "../../lib/ptyWorkspaceLayout";
import { fileContentKey } from "../../lib/workspaceContentKey";
import type {
  PtySession,
  ToolKey,
  WorkspacePaneContentRef,
} from "../../lib/tauri";
import { useCloseContents } from "./useCloseContents";
import type { WorkspaceRuntime } from "./useWorkspaceRuntime";
import type {
  PtyWorkspaceContextValue,
  SplitResizePhase,
  WorkspaceCommands,
} from "./workspaceContexts";

/** 命令回调与门面合成：只读 runtime 的实例，产出 commands 与 value。 */
export function useWorkspaceFacade(runtime: WorkspaceRuntime): {
  commands: WorkspaceCommands;
  value: PtyWorkspaceContextValue;
} {
  const {
    store,
    snapshot,
    tRef,
    directories,
    projection,
    persistence,
    persistenceStatus,
    orchestrator,
    fileDomain,
    ptyDomain,
    terminalRefs,
    portalTargets,
    commitTree,
    removeSlot,
    loadFile,
    executor,
    guards,
  } = runtime;
  const {
    tree,
    treeRevision: workspaceTreeRevision,
    focusedPaneId,
    slots,
    documents: fileDocuments,
    buffers: fileBuffers,
    hydrationStatus,
  } = snapshot;
  const {
    hydrationError,
    layoutSaveError,
    layoutResetError,
    layoutResetPending,
  } = persistenceStatus;
  const {
    detachedFileIds,
    detachedInstanceIds,
    handoffFileIds,
    closingContentKeys,
  } = projection;
  const {
    collectExitImpacts,
    getBackupRestoreBlockers,
    getDirectoryRemovalBlockers,
    cancelBackupRestore,
  } = guards;
  const splitResizeInProgressRef = useRef(false);

  const openProjectFile = useCallback(
    (
      directoryId: number,
      directoryPath: string,
      relativePath: string,
    ): Promise<void> =>
      fileDomain.open(
        { directoryId, directoryPath, relativePath },
        async (document) => {
          const detachedWindow =
            orchestrator.state.handles.file.get(fileContentKey(document.id)) ??
            orchestrator.state.pending.file.get(fileContentKey(document.id))
              ?.window;
          if (detachedWindow) {
            await detachedWindow
              .setFocus()
              .catch((error: unknown) =>
                reportWindowSyncFailure(
                  "window.set_focus_failed",
                  error,
                  "无法聚焦独立工作区窗口",
                ),
              );
            return;
          }

          executor.execute({
            type: "place",
            ref: { kind: "file", documentId: document.id },
          });
        },
      ),
    [executor, fileDomain],
  );

  const activateFile = useCallback(
    (paneId: string, documentId: string) => {
      executor.execute({
        type: "activate",
        ref: { kind: "file", documentId },
        paneId,
      });
    },
    [executor],
  );

  const activateUnsupportedContent = useCallback(
    (
      paneId: string,
      content: Extract<WorkspacePaneContentRef, { kind: "unknown" }>,
    ) => {
      executor.execute({ type: "activate", ref: content, paneId });
    },
    [executor],
  );

  const editFile = fileDomain.edit;
  const saveFile = fileDomain.save;

  const focusPane = useCallback(
    (paneId: string) => {
      executor.execute({ type: "focus", paneId });
    },
    [executor],
  );

  const closeContents = useCloseContents(runtime);

  const launchSession = useCallback(
    (directoryId: number, toolKey: ToolKey, resumeSessionId?: string) => {
      if (persistence.restoreLatch.active) return;
      const directory = directories?.find((entry) => entry.id === directoryId);
      if (!directory) {
        toast.error(tRef.current("pty.projectUnavailable"));
        return;
      }
      const slot = ptyDomain.createSlot(
        store.getLive().slots,
        { id: directoryId, path: directory.path, name: directory.name },
        toolKey,
        resumeSessionId,
      );
      executor.execute({ type: "launch", slot });
    },
    [directories, executor, ptyDomain, store],
  );

  const activateSession = useCallback(
    (paneId: string, instanceId: string) => {
      try {
        executor.execute({
          type: "activate",
          ref: { kind: "pty", slotId: instanceId },
          paneId,
        });
      } catch {
        return;
      }
    },
    [executor],
  );

  const splitPane = useCallback(
    (paneId: string, direction: SplitDirection) => {
      executor.execute({ type: "splitPane", paneId, direction });
    },
    [executor],
  );

  const splitAndMoveContent = useCallback(
    (
      paneId: string,
      content: WorkspacePaneContentRef,
      direction: SplitDirection,
    ) => {
      executor.execute({
        type: "split",
        ref: content,
        fromPaneId: paneId,
        direction,
      });
    },
    [executor],
  );

  const splitAndMoveSession = useCallback(
    (paneId: string, instanceId: string, direction: SplitDirection) =>
      splitAndMoveContent(
        paneId,
        { kind: "pty", slotId: instanceId },
        direction,
      ),
    [splitAndMoveContent],
  );

  const splitAndMoveFile = useCallback(
    (paneId: string, documentId: string, direction: SplitDirection) =>
      splitAndMoveContent(paneId, { kind: "file", documentId }, direction),
    [splitAndMoveContent],
  );

  const moveContent = useCallback(
    (
      sourcePaneId: string,
      destinationPaneId: string,
      content: WorkspacePaneContentRef,
    ) => {
      executor.execute({
        type: "move",
        ref: content,
        fromPaneId: sourcePaneId,
        toPaneId: destinationPaneId,
      });
    },
    [executor],
  );

  const moveSession = useCallback(
    (sourcePaneId: string, destinationPaneId: string, instanceId: string) =>
      moveContent(sourcePaneId, destinationPaneId, {
        kind: "pty",
        slotId: instanceId,
      }),
    [moveContent],
  );

  const moveFile = useCallback(
    (sourcePaneId: string, destinationPaneId: string, documentId: string) =>
      moveContent(sourcePaneId, destinationPaneId, {
        kind: "file",
        documentId,
      }),
    [moveContent],
  );

  const closeEmptyPane = useCallback(
    (paneId: string) => {
      executor.execute({ type: "closeEmptyPane", paneId });
    },
    [executor],
  );

  const updateSplitRatio = useCallback(
    (splitId: string, sizes: number[], phase: SplitResizePhase) => {
      const total = sizes.reduce((sum, size) => sum + size, 0);
      if (sizes.length !== 2 || total <= 0 || !Number.isFinite(total)) return;

      const nextTree = setWorkspaceSplitRatio(
        store.getLive().tree,
        splitId,
        sizes[0] / total,
      );
      // 拖拽过程只写未发布的临时树：getLive 可见，不发布、不通知。dragEnd 时再统一发布。
      if (phase !== "dragEnd") store.setTransientTree(nextTree);

      if (phase === "dragEnd") {
        splitResizeInProgressRef.current = false;
        persistence.cancelResizePersist();
        commitTree(nextTree);
        return;
      }

      splitResizeInProgressRef.current = true;
      persistence.schedulePersistAfterResize();
    },
    [commitTree, persistence],
  );

  const recordSession = useCallback(
    (instanceId: string, session: PtySession | null) => {
      if (!session) return;
      if (session.state === "exited" || session.state === "terminated") {
        removeSlot(instanceId);
        return;
      }
      store.commit(
        (live) => ptyDomain.recordSession(live, instanceId, session),
        "recordSession",
      );
    },
    [removeSlot, ptyDomain, store],
  );

  const resumeAfterFailedRestore = useCallback(() => {
    // 只有在替换数据库之前失败（守卫拒绝、恢复前的错误）才会返回 Err，此时数据库
    // 内容未变，内存状态仍与之一致。这里只解除持久化冻结，不重新加载工作区：
    // rehydrate 会清空 PTY 会话表，恢复检查之后启动的运行中 PTY 会因此失去前端句柄。
    persistence.restoreLatch.active = false;
    // 冻结期间的变更只是被跳过、没有丢弃（状态保留），解冻后立即保存，
    // 否则在下一次状态变化前它们都不会落盘。
    persistence.schedulePersist();
  }, []);

  const commands = useMemo<WorkspaceCommands>(
    () => ({
      launchSession,
      openProjectFile,
      loadFile,
      activateFile,
      activateUnsupportedContent,
      editFile,
      saveFile,
      closeContents,
      detachFile: orchestrator.detachFile,
      focusPane,
      activateSession,
      splitPane,
      splitAndMoveSession,
      splitAndMoveFile,
      moveSession,
      moveFile,
      isManagedDetachedDrag: orchestrator.isManagedDetachedDrag,
      isManagedDetachedFileDrag: orchestrator.isManagedDetachedFileDrag,
      detachSession: orchestrator.detachSession,
      closeEmptyPane,
      updateSplitRatio,
      retryHydration: persistence.retryHydration,
      resetWorkspace: persistence.resetWorkspace,
      applyWorkspaceLayoutPreset: persistence.applyPreset,
      getCurrentPresetLayout: persistence.currentPresetLayout,
      removeSlot,
      recordSession,
      collectExitImpacts,
      getBackupRestoreBlockers,
      cancelBackupRestore,
      resumeAfterFailedRestore,
      rehydrateWorkspace: persistence.rehydrate,
      getDirectoryRemovalBlockers,
    }),
    [
      launchSession,
      openProjectFile,
      loadFile,
      activateFile,
      activateUnsupportedContent,
      editFile,
      saveFile,
      closeContents,
      focusPane,
      activateSession,
      splitPane,
      splitAndMoveSession,
      splitAndMoveFile,
      moveSession,
      moveFile,
      closeEmptyPane,
      updateSplitRatio,
      persistence,
      removeSlot,
      recordSession,
      collectExitImpacts,
      getBackupRestoreBlockers,
      cancelBackupRestore,
      resumeAfterFailedRestore,
      getDirectoryRemovalBlockers,
    ],
  );
  const value = useMemo<PtyWorkspaceContextValue>(
    () => ({
      ...commands,
      slots,
      fileDocuments,
      fileBuffers,
      handoffFileIds,
      detachedFileIds,
      tree,
      workspaceTreeRevision,
      focusedPaneId,
      hydrationStatus,
      hydrationError,
      layoutSaveError,
      layoutResetError,
      layoutResetPending,
      portalTargets,
      terminalRefs,
      detachedInstanceIds,
      closingContentKeys,
      hasDetachedSessions: detachedInstanceIds.size > 0,
    }),
    [
      commands,
      slots,
      fileDocuments,
      fileBuffers,
      handoffFileIds,
      detachedFileIds,
      tree,
      workspaceTreeRevision,
      focusedPaneId,
      hydrationStatus,
      hydrationError,
      layoutSaveError,
      layoutResetError,
      layoutResetPending,
      portalTargets,
      terminalRefs,
      detachedInstanceIds,
      closingContentKeys,
    ],
  );

  return { commands, value };
}

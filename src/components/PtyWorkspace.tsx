import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  PtyWorkspaceContext,
  WorkspaceCommandsContext,
  usePtyWorkspace,
} from "../workspace/host/workspaceContexts";
import { WorkspaceHostStoreContext } from "../workspace/host/workspaceHostStore";
import { useWorkspaceFacade } from "../workspace/host/useWorkspaceFacade";
import {
  useWorkspaceRuntime,
  type WorkspaceRuntimeOptions,
} from "../workspace/host/useWorkspaceRuntime";
import { ImpactConfirmDialog } from "../workspace/views/ImpactConfirmDialog";
import { WorkspacePtySessionRegistry } from "./WorkspacePtySessionRegistry";
import "allotment/dist/style.css";

export { usePtyWorkspace };
export {
  WorkspaceRegion as PtyWorkspaceRegion,
  WorkspaceLayoutControls,
} from "../workspace/views/WorkspaceRegion";

export interface PtyWorkspaceProviderProps extends WorkspaceRuntimeOptions {
  children: ReactNode;
}

/** 宿主只做组装：实例构造交给 runtime，命令与门面合成交给 facade，这里只渲染。 */
export function PtyWorkspaceProvider(props: PtyWorkspaceProviderProps) {
  const { children, ...options } = props;
  const runtime = useWorkspaceRuntime(options);
  const { commands, value } = useWorkspaceFacade(runtime);
  const { snapshot, closeConfirmation } = runtime;
  const { t } = useTranslation();
  const [closeSaving, setCloseSaving] = useState(false);
  // m6-108：保存全部未保存的文件；全部成功后继续关闭，否则只保留仍未保存的文件并中止关闭。
  const saveAllAndClose = async () => {
    const documentIds = (closeConfirmation.impacts ?? []).flatMap((impact) =>
      impact.kind !== "runningPty" && impact.documentId !== undefined
        ? [impact.documentId]
        : [],
    );
    setCloseSaving(true);
    let remaining: string[];
    try {
      remaining = await commands.saveFiles(documentIds);
    } finally {
      setCloseSaving(false);
    }
    if (remaining.length === 0) {
      closeConfirmation.resolve(true);
      return;
    }
    closeConfirmation.keepUnsavedFiles(remaining);
    toast.error(
      t("workspaceFiles.saveAllFailedClose", { count: remaining.length }),
    );
  };
  return (
    <WorkspaceHostStoreContext.Provider value={runtime.store}>
      <WorkspaceCommandsContext.Provider value={commands}>
        <PtyWorkspaceContext.Provider value={value}>
          {children}
          {closeConfirmation.impacts && (
            <ImpactConfirmDialog
              impacts={closeConfirmation.impacts}
              busy={closeSaving}
              onCancel={() => closeConfirmation.resolve(false)}
              onConfirm={() => closeConfirmation.resolve(true)}
              onSaveAll={() => void saveAllAndClose()}
            />
          )}
          {(snapshot.hydrationStatus === "ready" ||
            snapshot.hydrationStatus === "needsReset") && (
            <WorkspacePtySessionRegistry
              slots={snapshot.slots}
              tree={snapshot.tree}
              focusedPaneId={snapshot.focusedPaneId}
              active={runtime.activeView === "detail"}
              terminalRefs={runtime.terminalRefs}
              onSessionChange={commands.recordSession}
              onPortalTarget={runtime.registerPortalTarget}
              onFocusPane={commands.focusPane}
              isDetachedContent={runtime.projection.isDetachedContent}
            />
          )}
        </PtyWorkspaceContext.Provider>
      </WorkspaceCommandsContext.Provider>
    </WorkspaceHostStoreContext.Provider>
  );
}

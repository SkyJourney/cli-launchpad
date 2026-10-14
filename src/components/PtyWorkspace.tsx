import type { ReactNode } from "react";
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
  return (
    <WorkspaceHostStoreContext.Provider value={runtime.store}>
      <WorkspaceCommandsContext.Provider value={commands}>
        <PtyWorkspaceContext.Provider value={value}>
          {children}
          {closeConfirmation.impacts && (
            <ImpactConfirmDialog
              impacts={closeConfirmation.impacts}
              onCancel={() => closeConfirmation.resolve(false)}
              onConfirm={() => closeConfirmation.resolve(true)}
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
              detachedInstanceIds={runtime.projection.detachedInstanceIds}
            />
          )}
        </PtyWorkspaceContext.Provider>
      </WorkspaceCommandsContext.Provider>
    </WorkspaceHostStoreContext.Provider>
  );
}

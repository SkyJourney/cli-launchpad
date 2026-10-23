import type { AppErrorState } from "../../lib/appErrors";
import { createContext, useContext, type MutableRefObject } from "react";
import type { PtyTerminalHandle } from "../../components/PtyTerminal";
import type { PtyWorkspaceSlot } from "../../components/WorkspacePtySessionRegistry";
import type { AppExitImpacts } from "../../lib/appExitImpacts";
import type {
  PtySession,
  ToolKey,
  WorkspaceFileDocument,
  WorkspaceLayoutDocument,
  WorkspacePaneContentRef,
} from "../../lib/tauri";
import type { WorkspaceFileBuffer } from "../../lib/workspaceFileBuffer";
import type {
  SplitDirection,
  WorkspaceNode,
} from "../../lib/ptyWorkspaceLayout";
import type { WorkspaceDataRestoreBlockers } from "../../lib/workspaceRestorePolicy";
import type { HostHydrationStatus } from "./workspaceHostStore";

export type PtyWorkspaceHydrationStatus = HostHydrationStatus;

export type SplitResizePhase = "change" | "dragEnd";

export interface PtyWorkspaceContextValue {
  slots: PtyWorkspaceSlot[];
  fileDocuments: WorkspaceFileDocument[];
  fileBuffers: Record<string, WorkspaceFileBuffer>;
  isHandoffContent: (content: WorkspacePaneContentRef) => boolean;
  isDetachedContent: (content: WorkspacePaneContentRef) => boolean;
  tree: WorkspaceNode;
  workspaceTreeRevision: number;
  focusedPaneId: string;
  hydrationStatus: PtyWorkspaceHydrationStatus;
  hydrationError: AppErrorState | null;
  layoutSaveError: AppErrorState | null;
  layoutResetError: AppErrorState | null;
  layoutResetPending: boolean;
  portalTargets: Record<string, HTMLDivElement>;
  terminalRefs: MutableRefObject<Map<string, PtyTerminalHandle>>;
  launchSession: (
    directoryId: number,
    toolKey: ToolKey,
    resumeSessionId?: string,
  ) => void;
  openProjectFile: (
    directoryId: number,
    directoryPath: string,
    relativePath: string,
  ) => Promise<void>;
  loadFile: (documentId: string) => Promise<void>;
  activateContent: (paneId: string, content: WorkspacePaneContentRef) => void;
  editFile: (documentId: string, content: string) => void;
  saveFile: (documentId: string) => Promise<void>;
  closeContents: (
    contents: WorkspacePaneContentRef[],
    origin: "tab" | "menu" | "stack" | "window",
    onApproved?: () => void,
  ) => Promise<void>;
  detachFile: (documentId: string) => Promise<void>;
  focusPane: (paneId: string) => void;
  splitPane: (paneId: string, direction: SplitDirection) => void;
  splitAndMoveContent: (
    paneId: string,
    content: WorkspacePaneContentRef,
    direction: SplitDirection,
  ) => void;
  moveContent: (
    sourcePaneId: string,
    destinationPaneId: string,
    content: WorkspacePaneContentRef,
  ) => void;
  detachedWindowContents: WorkspacePaneContentRef[];
  closingContentKeys: Set<string>;
  hasDetachedSessions: boolean;
  isManagedDetachedDrag: (instanceId: string, windowLabel: string) => boolean;
  isManagedDetachedFileDrag: (
    documentId: string,
    windowLabel: string,
  ) => boolean;
  detachSession: (instanceId: string) => Promise<void>;
  closeEmptyPane: (paneId: string) => void;
  updateSplitRatio: (
    splitId: string,
    sizes: number[],
    phase: SplitResizePhase,
  ) => void;
  retryHydration: () => void;
  resetWorkspace: () => Promise<void>;
  applyWorkspaceLayoutPreset: (presetId: string) => Promise<void>;
  getCurrentPresetLayout: () => WorkspaceLayoutDocument;
  removeSlot: (
    instanceId: string,
    options?: { disposeOwnerEnded?: boolean },
  ) => void;
  recordSession: (instanceId: string, session: PtySession | null) => void;
  collectExitImpacts: (ptyCount: number) => Promise<AppExitImpacts>;
  /** m6-108：按顺序保存仍然脏的文件，返回保存后仍未保存的文件 id（空数组表示全部已保存）。 */
  saveFiles: (documentIds: readonly string[]) => Promise<string[]>;
  getBackupRestoreBlockers: () => Promise<WorkspaceDataRestoreBlockers>;
  cancelBackupRestore: () => void;
  resumeAfterFailedRestore: () => void;
  rehydrateWorkspace: () => Promise<void>;
  getDirectoryRemovalBlockers: (directoryId: number) => {
    openFileCount: number;
    runningPtyCount: number;
  };
}

export const PtyWorkspaceContext =
  createContext<PtyWorkspaceContextValue | null>(null);

export function usePtyWorkspace() {
  const workspace = useContext(PtyWorkspaceContext);
  if (!workspace) {
    throw new Error("PtyWorkspaceProvider is missing");
  }
  return workspace;
}

/**
 * 命令成员：宿主里每个函数字段都是稳定的，状态变化不会改变它们的身份。
 * 与 PtyWorkspaceContextValue 的函数字段一一对应（CTX-1 与门面测试守护）。
 */
export const WORKSPACE_COMMAND_KEYS = [
  "launchSession",
  "openProjectFile",
  "loadFile",
  "activateContent",
  "editFile",
  "saveFile",
  "closeContents",
  "detachFile",
  "focusPane",
  "splitPane",
  "splitAndMoveContent",
  "moveContent",
  "isManagedDetachedDrag",
  "isManagedDetachedFileDrag",
  "detachSession",
  "closeEmptyPane",
  "updateSplitRatio",
  "retryHydration",
  "resetWorkspace",
  "applyWorkspaceLayoutPreset",
  "getCurrentPresetLayout",
  "removeSlot",
  "recordSession",
  "collectExitImpacts",
  "saveFiles",
  "getBackupRestoreBlockers",
  "cancelBackupRestore",
  "resumeAfterFailedRestore",
  "rehydrateWorkspace",
  "getDirectoryRemovalBlockers",
] as const satisfies readonly (keyof PtyWorkspaceContextValue)[];

/** 状态查询函数：随协调器投影变化而更换身份，不属于稳定命令清单，但同样是门面的函数字段。 */
export const WORKSPACE_STATE_QUERY_KEYS = [
  "isDetachedContent",
  "isHandoffContent",
] as const satisfies readonly (keyof PtyWorkspaceContextValue)[];

export type WorkspaceCommands = Pick<
  PtyWorkspaceContextValue,
  (typeof WORKSPACE_COMMAND_KEYS)[number]
>;

export const WorkspaceCommandsContext = createContext<WorkspaceCommands | null>(
  null,
);

export function useWorkspaceCommands(): WorkspaceCommands {
  const commands = useContext(WorkspaceCommandsContext);
  if (!commands) throw new Error("WorkspaceCommandsContext is missing");
  return commands;
}

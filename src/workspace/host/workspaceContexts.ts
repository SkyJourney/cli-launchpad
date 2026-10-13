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
  handoffFileIds: Set<string>;
  detachedFileIds: Set<string>;
  tree: WorkspaceNode;
  workspaceTreeRevision: number;
  focusedPaneId: string;
  hydrationStatus: PtyWorkspaceHydrationStatus;
  hydrationError: string | null;
  layoutSaveError: string | null;
  layoutResetError: string | null;
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
  activateFile: (paneId: string, documentId: string) => void;
  activateUnsupportedContent: (
    paneId: string,
    content: Extract<WorkspacePaneContentRef, { kind: "unknown" }>,
  ) => void;
  editFile: (documentId: string, content: string) => void;
  saveFile: (documentId: string) => Promise<void>;
  closeContents: (
    contents: WorkspacePaneContentRef[],
    origin: "tab" | "menu" | "stack" | "window",
    onApproved?: () => void,
  ) => Promise<void>;
  detachFile: (documentId: string) => Promise<void>;
  focusPane: (paneId: string) => void;
  activateSession: (paneId: string, instanceId: string) => void;
  splitPane: (paneId: string, direction: SplitDirection) => void;
  splitAndMoveSession: (
    paneId: string,
    instanceId: string,
    direction: SplitDirection,
  ) => void;
  splitAndMoveFile: (
    paneId: string,
    documentId: string,
    direction: SplitDirection,
  ) => void;
  moveSession: (
    sourcePaneId: string,
    destinationPaneId: string,
    instanceId: string,
  ) => void;
  moveFile: (
    sourcePaneId: string,
    destinationPaneId: string,
    documentId: string,
  ) => void;
  detachedInstanceIds: Set<string>;
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
  "activateFile",
  "activateUnsupportedContent",
  "editFile",
  "saveFile",
  "closeContents",
  "detachFile",
  "focusPane",
  "activateSession",
  "splitPane",
  "splitAndMoveSession",
  "splitAndMoveFile",
  "moveSession",
  "moveFile",
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
  "getBackupRestoreBlockers",
  "cancelBackupRestore",
  "resumeAfterFailedRestore",
  "rehydrateWorkspace",
  "getDirectoryRemovalBlockers",
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

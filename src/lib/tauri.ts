import { Channel } from "@tauri-apps/api/core";
import { invokeApp } from "./invokeApp";
import type { RegisteredToolKey } from "../generated/toolKeys";
import type { RegisteredContentRef } from "../generated/contentKinds";
import type { PathSemantics } from "./pathKey";
import {
  parseExitImpactsView,
  type ExitImpactsView,
  type ReportedDirtyFile,
} from "./exitRequest";

export type { PathSemantics };

export type ToolKey = RegisteredToolKey;

export type WorkspaceLayoutNode =
  | {
      kind: "pane";
      id: string;
      paneNumber: number;
      contents: WorkspacePaneContentRef[];
      activeContent?: WorkspacePaneContentRef | null;
    }
  | {
      kind: "split";
      id: string;
      direction: "horizontal" | "vertical";
      ratio: number;
      first: WorkspaceLayoutNode;
      second: WorkspaceLayoutNode;
    };

export type WorkspaceSlotTitle =
  | { kind: "automatic" }
  | { kind: "custom"; value: string };

export interface WorkspaceLayoutSlot {
  instanceId: string;
  directoryId: number;
  directoryPath: string;
  projectName: string;
  toolKey: ToolKey;
  sequence: number;
  sessionId: string | null;
  resumeSessionId: string | null;
  title: WorkspaceSlotTitle;
}

export interface WorkspaceLayoutDocument {
  schemaVersion: number;
  tree: WorkspaceLayoutNode;
  focusedPaneId: string;
  slots: WorkspaceLayoutSlot[];
  documents: WorkspaceFileDocument[];
  detachedContents: WorkspacePaneContentRef[];
}

export type WorkspacePaneContentRef =
  | RegisteredContentRef
  | { kind: "unknown"; originalKind: string; raw: Record<string, unknown> };

export interface WorkspaceFileDocument {
  id: string;
  directoryId: number;
  directoryPath: string;
  relativePath: string;
}

export type WorkspaceLayoutStateStatus =
  | { status: "missing" }
  | { status: "ready" }
  | {
      status: "needsReset";
      reason: {
        code: "unsupportedVersion" | "versionMismatch" | "invalidPayload";
        detail: string;
      };
    };

export type WorkspaceSlotStateKind =
  | "pending"
  | "running"
  | "ended"
  | "missingProject"
  | "projectIdentityMismatch"
  | "missingSession"
  | "sessionIdentityMismatch";

export interface WorkspaceSlotState {
  instanceId: string;
  state: WorkspaceSlotStateKind;
  currentProjectName: string | null;
}

export interface WorkspaceLayoutStateRead {
  status: WorkspaceLayoutStateStatus;
  revision: number | null;
  schemaVersion: number | null;
  updatedAtMs: number | null;
  layout: WorkspaceLayoutDocument | null;
  slotStates: WorkspaceSlotState[];
}

export type WorkspaceLayoutSaveResult =
  | { saved: true; revision: number }
  | { saved: false; reason?: "stale" | "incompatible"; revision: number };

export interface WorkspaceLayoutPresetSummary {
  id: string;
  name: string;
  schemaVersion: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface WorkspaceLayoutApplyPlan {
  layout: WorkspaceLayoutDocument;
  slotStates: WorkspaceSlotState[];
}

export interface Directory {
  id: number;
  name: string;
  path: string;
  sortOrder: number;
  pinned: boolean;
  note: string | null;
}

export interface ProjectFileEntry {
  name: string;
  relativePath: string;
  kind: "directory" | "file" | "other";
  size: number;
  hidden: boolean;
  ignored: boolean;
  symbolicLink: boolean;
}

/** Whether two project files are the same file on disk (PD-10 safety net). */
export type FileIdentityComparison = "same" | "different" | "unavailable";

export interface ProjectDirectoryListing {
  entries: ProjectFileEntry[];
  truncated: boolean;
  skippedCount: number;
  pathSemantics: PathSemantics;
}

export interface ProjectFileCasResidue {
  relativePath: string;
  sizeBytes: number;
  modifiedAtMs: number;
  fileIdentity: string;
}

export interface ProjectFileCasResidueListing {
  entries: ProjectFileCasResidue[];
  truncated: boolean;
  skippedCount: number;
}

export type ProjectTextFileSaveResult =
  | {
      kind: "saved";
      content: string;
      revision: string;
      warning: "permissionsNotRestored" | null;
    }
  | { kind: "conflict" };

export type ProjectFileOpenResult =
  | { kind: "text"; content: string; revision: string }
  | { kind: "image"; mimeType: string; base64Data: string }
  | {
      kind: "unsupported";
      reason: "binary" | "tooLarge" | "invalidImage" | "unsupportedImage";
    };

export type CloseBehavior = "minimize_to_tray" | "quit";

export interface SessionInfo {
  toolKey: ToolKey;
  sessionId: string;
  title: string;
  alias: string | null;
  lastActiveMs: number | null;
}

export interface SessionPage {
  items: SessionInfo[];
  nextCursor: string | null;
}

export interface SessionSearchResults {
  items: SessionInfo[];
  incompleteTools: ToolKey[];
}

export interface SessionSearchIndexRefresh {
  incompleteTools: ToolKey[];
  indexedSessions: number;
}

export interface PtySession {
  sessionId: string;
  directoryId: number;
  toolKey: ToolKey;
  workingDirectory: string;
  state: "running" | "exited" | "terminated" | "failed";
  startedAtMs: number;
  endedAtMs: number | null;
  exitCode: number | null;
}

export type PtySessionWindowState =
  | "running"
  | "ended"
  | "ownedByAnotherWindow";

export interface PtySessionWindowStatus {
  state: PtySessionWindowState;
  ownerLabel: string | null;
}

/** Rust 序列化的原始 DTO（`PtySessionWindowStatusReport`，camelCase）。 */
export interface PtySessionWindowStatusDto {
  status: PtySessionWindowState;
  ownerWindowLabel: string | null;
}

/**
 * DTO 到前端类型的唯一映射点；未知状态直接抛错，不静默容忍。
 * 用 const 箭头函数而不是 export function：appCommands.contract.test.ts 把 tauri.ts
 * 里每个 export function 都当作 invoke 封装来解析，纯映射函数不能写成那种形态。
 */
export const toPtySessionWindowStatus = (
  dto: PtySessionWindowStatusDto,
): PtySessionWindowStatus => {
  if (
    dto.status !== "running" &&
    dto.status !== "ended" &&
    dto.status !== "ownedByAnotherWindow"
  ) {
    throw new Error(`Unknown PTY window status: ${String(dto.status)}`);
  }
  return { state: dto.status, ownerLabel: dto.ownerWindowLabel ?? null };
};

export interface PtySizeUpdate {
  cols: number;
  rows: number;
  pixelWidth: number;
  pixelHeight: number;
}

export interface PtyHandoff {
  token: string;
  sequence: number;
}

export interface PtyTerminalSnapshot {
  data: string;
  cols: number;
  rows: number;
}

export type PtyEvent =
  | { type: "output"; sessionId: string; sequence: number; dataBase64: string }
  | {
      type: "snapshot";
      sessionId: string;
      sequence: number;
      data: string;
      cols: number;
      rows: number;
    }
  | {
      type: "exited";
      sessionId: string;
      state: PtySession["state"];
      exitCode: number | null;
    }
  | { type: "failed"; sessionId: string; message: string };

export type PtyFrontendStage =
  | "startupInputFlushed"
  | "outputReceived"
  | "outputDecodeFailed"
  | "xtermWritePending"
  | "xtermWriteCompleted"
  | "xtermWriteFailed"
  | "rendererPaused"
  | "rendererResumed";

export type InstallKind = "install" | "update";

export interface InstallPlan {
  toolKey: ToolKey;
  kind: InstallKind;
  program: string;
  args: string[];
  fingerprint: string;
  source: string;
  preview: string;
}

export type ExecutionStatus =
  | "preparing"
  | "running"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "interrupted";

export type ExecutionStream = "stdout" | "stderr" | "system";

export interface ExecutionTask {
  id: string;
  toolKey: ToolKey;
  kind: InstallKind;
  source: string;
  preview: string;
  status: ExecutionStatus;
  startedAtMs: number;
  finishedAtMs: number | null;
  exitCode: number | null;
  errorMessage: string | null;
  logTruncated: boolean;
}

export interface ExecutionLogChunk {
  taskId: string;
  sequence: number;
  stream: ExecutionStream;
  content: string;
  createdAtMs: number;
}

export interface ExecutionTaskDetail {
  task: ExecutionTask;
  logs: ExecutionLogChunk[];
}

export interface LatestVersion {
  toolKey: ToolKey;
  latest: string | null;
  updateAvailability: "available" | "upToDate" | "unknown";
  commitsBehind: number | null;
  error: string | null;
  fromCache: boolean;
  managedUpdate:
    | { status: "allowed" }
    | { status: "denied"; reasonKey: string }
    | { status: "notApplicable" };
}

export type BackupReason =
  | "manual"
  | "pre_import"
  | "pre_restore"
  | "pre_migration"
  | "pre_case_merge";

export interface BackupManifest {
  id: string;
  createdAtMs: number;
  reason: BackupReason;
  schemaVersion: number;
  databaseFilename: string;
  sizeBytes: number;
}

export interface LaunchHistoryEntry {
  id: number;
  directoryName: string;
  directoryPath: string;
  toolKey: ToolKey;
  action: "launch" | "resume";
  success: boolean;
  errorCategory: string | null;
  launchedAt: string;
  ptySessionId: string | null;
}

export interface CacheStats {
  sizeBytes: number;
  entryCount: number;
  newestEntryAtMs: number | null;
}

export type CliAvailability = "available" | "missing" | "unknown";

export interface CliStatus {
  toolKey: ToolKey;
  status: CliAvailability;
  path: string | null;
  resolvedCommand: string | null;
  version: string | null;
  versionError: string | null;
  latestVersion: string | null;
}

// Directories
export function listDirectories() {
  return invokeApp<Directory[]>("list_directories");
}

export function addDirectory(name: string, path: string, note?: string | null) {
  return invokeApp<Directory>("add_directory", {
    name,
    path,
    note: note ?? null,
  });
}

export function updateDirectory(
  id: number,
  name: string,
  note?: string | null,
) {
  return invokeApp<void>("update_directory", { id, name, note: note ?? null });
}

export function removeDirectory(id: number) {
  return invokeApp<void>("remove_directory", { id });
}

export function setDirectoryPinned(id: number, pinned: boolean) {
  return invokeApp<void>("set_directory_pinned", { id, pinned });
}

export function reorderDirectories(orderedIds: number[], pinned: boolean) {
  return invokeApp<void>("reorder_directories", { orderedIds, pinned });
}

export function openProjectDirectory(id: number) {
  return invokeApp<void>("open_project_directory", { id });
}

export function listProjectFiles(
  directoryId: number,
  directoryPath: string,
  relativePath = "",
) {
  return invokeApp<ProjectDirectoryListing>("list_project_files", {
    directoryId,
    directoryPath,
    relativePath,
  });
}

export function getProjectPathSemantics(
  directoryId: number,
  directoryPath: string,
) {
  return invokeApp<PathSemantics>("get_project_path_semantics", {
    directoryId,
    directoryPath,
  });
}

export function checkProjectFilesSameIdentity(
  directoryId: number,
  directoryPath: string,
  a: string,
  b: string,
) {
  return invokeApp<FileIdentityComparison>(
    "check_project_files_same_identity",
    {
      directoryId,
      directoryPath,
      a,
      b,
    },
  );
}

export function openProjectFile(
  directoryId: number,
  directoryPath: string,
  relativePath: string,
) {
  return invokeApp<ProjectFileOpenResult>("open_project_file", {
    directoryId,
    directoryPath,
    relativePath,
  });
}

export function saveProjectTextFile(
  directoryId: number,
  directoryPath: string,
  relativePath: string,
  content: string,
  expectedRevision: string,
) {
  return invokeApp<ProjectTextFileSaveResult>("save_project_text_file", {
    directoryId,
    directoryPath,
    relativePath,
    content,
    expectedRevision,
  });
}

export function grantContentWindowFile(
  targetLabel: string,
  directoryId: number,
  directoryPath: string,
  relativePath: string,
) {
  return invokeApp<void>("grant_content_window_file", {
    targetLabel,
    directoryId,
    directoryPath,
    relativePath,
  });
}

export function openGrantedFile() {
  return invokeApp<ProjectFileOpenResult>("open_granted_file");
}

export function saveGrantedTextFile(content: string, expectedRevision: string) {
  return invokeApp<ProjectTextFileSaveResult>("save_granted_text_file", {
    content,
    expectedRevision,
  });
}

export function revokeContentWindowFile(targetLabel: string) {
  return invokeApp<boolean>("revoke_content_window_file", { targetLabel });
}

export function listProjectFileCasResidues(
  directoryId: number,
  directoryPath: string,
) {
  return invokeApp<ProjectFileCasResidueListing>(
    "list_project_file_cas_residues",
    { directoryId, directoryPath },
  );
}

export function removeProjectFileCasResidue(
  directoryId: number,
  directoryPath: string,
  residue: ProjectFileCasResidue,
) {
  return invokeApp<void>("remove_project_file_cas_residue", {
    directoryId,
    directoryPath,
    relativePath: residue.relativePath,
    sizeBytes: residue.sizeBytes,
    modifiedAtMs: residue.modifiedAtMs,
    fileIdentity: residue.fileIdentity,
  });
}

// CLI detection
export function detectCliStatus(toolKey?: ToolKey, force = false) {
  return invokeApp<CliStatus[]>("detect_cli_status", { force, toolKey });
}

// Config backup (file-based)
export function exportConfigToPath(path: string) {
  return invokeApp<void>("export_config_to_path", { path });
}

export function importConfigFromPath(path: string) {
  return invokeApp<void>("import_config_from_path", { path });
}

export function exportDiagnosticsToPath(path: string) {
  return invokeApp<void>("export_diagnostics_to_path", { path });
}

export function listBackups() {
  return invokeApp<BackupManifest[]>("list_backups");
}

export function createBackup() {
  return invokeApp<BackupManifest>("create_backup");
}

export function restoreBackup(backupId: string) {
  return invokeApp<BackupManifest>("restore_backup", { backupId });
}

export function listLaunchHistory() {
  return invokeApp<LaunchHistoryEntry[]>("list_launch_history");
}

export function clearLaunchHistory() {
  return invokeApp<void>("clear_launch_history");
}

export function getLaunchHistoryLimit() {
  return invokeApp<number>("get_launch_history_limit");
}

export function setLaunchHistoryLimit(limit: number) {
  return invokeApp<void>("set_launch_history_limit", { limit });
}

// Version & install/update
export function fetchLatestVersion(toolKey: ToolKey, force = false) {
  return invokeApp<LatestVersion>("fetch_latest_version", {
    toolKey,
    force,
  });
}

export function getInstallPlan(toolKey: ToolKey, kind: InstallKind) {
  return invokeApp<InstallPlan>("get_install_plan", { toolKey, kind });
}

export function startExecutionTask(plan: InstallPlan) {
  return invokeApp<ExecutionTask>("start_execution_task", {
    toolKey: plan.toolKey,
    kind: plan.kind,
    expectedFingerprint: plan.fingerprint,
  });
}

export function listExecutionTasks() {
  return invokeApp<ExecutionTask[]>("list_execution_tasks");
}

export function getExecutionTask(taskId: string) {
  return invokeApp<ExecutionTaskDetail>("get_execution_task", { taskId });
}

export function cancelExecutionTask(taskId: string) {
  return invokeApp<ExecutionTask>("cancel_execution_task", { taskId });
}

export function clearExecutionTask(taskId: string) {
  return invokeApp<void>("clear_execution_task", { taskId });
}

export function clearExecutionHistory() {
  return invokeApp<number>("clear_execution_history");
}

// Embedded PTY sessions
export function getWorkspaceLayout() {
  return invokeApp<WorkspaceLayoutStateRead>("get_workspace_layout");
}

export function saveWorkspaceLayout(
  revision: number,
  layout: WorkspaceLayoutDocument,
) {
  return invokeApp<WorkspaceLayoutSaveResult>("save_workspace_layout", {
    revision,
    layout,
  });
}

export function resetWorkspaceLayout() {
  return invokeApp<number>("reset_workspace_layout");
}

export function listWorkspaceLayoutPresets() {
  return invokeApp<WorkspaceLayoutPresetSummary[]>(
    "list_workspace_layout_presets",
  );
}

export function createWorkspaceLayoutPreset(
  name: string,
  layout: WorkspaceLayoutDocument,
) {
  return invokeApp<WorkspaceLayoutPresetSummary>(
    "create_workspace_layout_preset",
    { name, layout },
  );
}

export function updateWorkspaceLayoutPreset(
  id: string,
  layout: WorkspaceLayoutDocument,
) {
  return invokeApp<boolean>("update_workspace_layout_preset", { id, layout });
}

export function renameWorkspaceLayoutPreset(id: string, name: string) {
  return invokeApp<boolean>("rename_workspace_layout_preset", { id, name });
}

export function deleteWorkspaceLayoutPreset(id: string) {
  return invokeApp<boolean>("delete_workspace_layout_preset", { id });
}

export function planApplyWorkspaceLayoutPreset(
  id: string,
  activeLayout: WorkspaceLayoutDocument,
) {
  return invokeApp<WorkspaceLayoutApplyPlan>(
    "plan_apply_workspace_layout_preset",
    { id, activeLayout },
  );
}

export function createPtySession(
  directoryId: number,
  toolKey: ToolKey,
  size: PtySizeUpdate,
  onEvent: Channel<PtyEvent>,
  resumeSessionId?: string,
) {
  return invokeApp<PtySession>("create_pty_session", {
    directoryId,
    toolKey,
    size,
    onEvent,
    resumeSessionId,
  });
}

export function beginPtyHandoff(sessionId: string, targetWindowLabel: string) {
  return invokeApp<PtyHandoff>("begin_pty_handoff", {
    sessionId,
    targetWindowLabel,
  });
}

export function stagePtyHandoffSnapshot(
  sessionId: string,
  token: string,
  sequence: number,
  snapshot: PtyTerminalSnapshot,
) {
  return invokeApp<void>("stage_pty_handoff_snapshot", {
    sessionId,
    token,
    sequence,
    snapshot,
  });
}

export function completePtyHandoff(
  sessionId: string,
  token: string,
  onEvent: Channel<PtyEvent>,
) {
  return invokeApp<PtySession>("complete_pty_handoff", {
    sessionId,
    token,
    onEvent,
  });
}

export function finalizePtyHandoff(
  sessionId: string,
  token: string,
  size: PtySizeUpdate,
) {
  return invokeApp<PtySession>("finalize_pty_handoff", {
    sessionId,
    token,
    size,
  });
}

export function cancelPtyHandoff(sessionId: string, token: string) {
  return invokeApp<void>("cancel_pty_handoff", { sessionId, token });
}

export async function getPtySessionWindowStatus(sessionId: string) {
  return toPtySessionWindowStatus(
    await invokeApp<PtySessionWindowStatusDto>(
      "get_pty_session_window_status",
      {
        sessionId,
      },
    ),
  );
}

export function reattachPtySession(
  sessionId: string,
  onEvent: Channel<PtyEvent>,
  snapshot: PtyTerminalSnapshot,
  sequence: number,
  size: PtySizeUpdate,
) {
  return invokeApp<PtySession>("reattach_pty_session", {
    sessionId,
    onEvent,
    snapshot,
    sequence,
    size,
  });
}

export function writePtySession(sessionId: string, data: string) {
  return invokeApp<void>("write_pty_session", { sessionId, data });
}

export function resizePtySession(sessionId: string, size: PtySizeUpdate) {
  return invokeApp<void>("resize_pty_session", { sessionId, size });
}

export function acknowledgePtyOutput(sessionId: string, sequence: number) {
  return invokeApp<void>("acknowledge_pty_output", { sessionId, sequence });
}

export function reportPtyFrontendStage(
  sessionId: string,
  stage: PtyFrontendStage,
) {
  return invokeApp<void>("report_pty_frontend_stage", { sessionId, stage });
}

export function reportWindowSyncFailureToBackend(
  code: string,
  message: string,
) {
  return invokeApp<void>("report_window_sync_failure", { code, message });
}

export function terminatePtySession(sessionId: string) {
  return invokeApp<void>("terminate_pty_session", { sessionId });
}

export function confirmAppExit(requestId: string) {
  return invokeApp<void>("confirm_app_exit", { requestId });
}

/** m6-101：上报未保存文件，返回 Rust 重算后的退出影响；形状或请求 id 不符时拒绝。 */
export function reportExitImpacts(
  requestId: string,
  dirtyFiles: ReportedDirtyFile[],
): Promise<ExitImpactsView> {
  return invokeApp<unknown>("report_exit_impacts", {
    requestId,
    dirtyFiles,
  }).then((raw) => {
    const view = parseExitImpactsView(raw, requestId);
    if (!view) throw new Error("malformed exit impacts view");
    return view;
  });
}

export interface WindowInboxSource {
  label: string;
  kind: "main" | "terminal" | "workspaceContent";
}

/** One message of the window inbox (`src-tauri/src/services/window_inbox.rs`). */
export interface InboxMessage {
  seq: number;
  event: string;
  payload: unknown;
  source: WindowInboxSource | null;
}

export interface WindowInboxSubscription {
  replaced: boolean;
  flushed: number;
  dropped: number;
}

/** Use `onInboxEvent` from `./windowInbox` instead of calling this directly. */
export function subscribeWindowInbox(onEvent: Channel<InboxMessage>) {
  return invokeApp<WindowInboxSubscription>("subscribe_window_inbox", {
    onEvent,
  });
}

export interface SendWindowMessageResult {
  delivered: boolean;
}

/**
 * Relays one envelope to another window through Rust, which checks the message type against
 * `contracts/window-messages.json` and stamps the sender. Use `sendWindowMessage` from
 * `./windowMessages` instead of calling this directly.
 */
export function sendWindowMessageCommand(
  target: string,
  messageType: string,
  payload: unknown,
) {
  return invokeApp<SendWindowMessageResult>("send_window_message", {
    target,
    messageType,
    payload,
  });
}

export interface StartupNotice {
  kind: "abnormal_exit_detected";
  startedAtMs: number | null;
}

export function takeStartupNotices() {
  return invokeApp<StartupNotice[]>("take_startup_notices");
}

export function getCloseBehavior() {
  return invokeApp<CloseBehavior>("get_close_behavior");
}

export function setCloseBehavior(closeBehavior: CloseBehavior) {
  return invokeApp<void>("set_close_behavior", { closeBehavior });
}

export function setTrayMenuLabels(labels: { show: string; quit: string }) {
  return invokeApp<void>("set_tray_menu_labels", {
    show: labels.show,
    quit: labels.quit,
  });
}

// Sessions
export function listSessionPage(
  directoryId: number,
  toolKey: ToolKey,
  cursor: string | null = null,
  limit = 10,
) {
  return invokeApp<SessionPage>("list_sessions", {
    directoryId,
    toolKey,
    cursor,
    limit,
  });
}

export function searchSessions(directoryId: number, query: string) {
  return invokeApp<SessionSearchResults>("search_sessions", {
    directoryId,
    query,
  });
}

export function refreshSessionSearchIndex(directoryId: number) {
  return invokeApp<SessionSearchIndexRefresh>("refresh_session_search_index", {
    directoryId,
  });
}

export function setSessionAlias(
  directoryId: number,
  toolKey: ToolKey,
  sessionId: string,
  alias: string,
) {
  return invokeApp<void>("set_session_alias", {
    directoryId,
    toolKey,
    sessionId,
    alias,
  });
}

export function deleteSessionAlias(
  directoryId: number,
  toolKey: ToolKey,
  sessionId: string,
) {
  return invokeApp<void>("delete_session_alias", {
    directoryId,
    toolKey,
    sessionId,
  });
}

export function getCacheStats() {
  return invokeApp<CacheStats>("get_cache_stats");
}

export function clearCache() {
  return invokeApp<void>("clear_cache");
}

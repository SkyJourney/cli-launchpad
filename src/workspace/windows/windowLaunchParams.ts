import toolKeys from "../../../contracts/tool-keys.json";
import type { ToolKey } from "../../lib/tauri";
import { fileContentRef } from "../../lib/workspaceContentKey";

export interface PtyLaunchParams {
  kind: "pty";
  sessionId: string;
  handoffToken: string;
  instanceId: string;
  sourcePaneId: string;
  toolKey?: ToolKey;
  title?: string;
}

export interface FileLaunchParams {
  kind: "file";
  documentId: string;
  handoffToken: string;
  sourcePaneId: string;
}

export type WindowLaunchParams = PtyLaunchParams | FileLaunchParams;

/** Wire names are a contract between the main window and the child windows. */
export const LAUNCH_PARAM_NAMES = {
  pty: {
    sessionId: "detachedSessionId",
    handoffToken: "handoffToken",
    instanceId: "instanceId",
    title: "detachedTitle",
    toolKey: "detachedToolKey",
    sourcePaneId: "sourcePaneId",
  },
  file: {
    documentId: "detachedFileId",
    handoffToken: "fileHandoffToken",
    sourcePaneId: "sourcePaneId",
  },
} as const;

const UNKNOWN_PANE = "unknown-pane";

export function writeWindowLaunchParams(
  search: URLSearchParams,
  params: WindowLaunchParams,
): void {
  if (params.kind === "pty") {
    const names = LAUNCH_PARAM_NAMES.pty;
    search.set(names.sessionId, params.sessionId);
    search.set(names.handoffToken, params.handoffToken);
    search.set(names.instanceId, params.instanceId);
    if (params.title !== undefined) search.set(names.title, params.title);
    if (params.toolKey !== undefined) search.set(names.toolKey, params.toolKey);
    search.set(names.sourcePaneId, params.sourcePaneId);
    return;
  }
  const names = LAUNCH_PARAM_NAMES.file;
  search.set(names.documentId, params.documentId);
  search.set(names.handoffToken, params.handoffToken);
  search.set(names.sourcePaneId, params.sourcePaneId);
}

export function readPtyLaunchParams(
  search: URLSearchParams,
): PtyLaunchParams | null {
  const names = LAUNCH_PARAM_NAMES.pty;
  const sessionId = search.get(names.sessionId);
  const handoffToken = search.get(names.handoffToken);
  const instanceId = search.get(names.instanceId);
  if (!sessionId || !handoffToken || !instanceId) return null;
  const rawToolKey = search.get(names.toolKey);
  const toolKey = (toolKeys.items as readonly string[]).includes(
    rawToolKey ?? "",
  )
    ? (rawToolKey as ToolKey)
    : undefined;
  const title = search.get(names.title);
  return {
    kind: "pty",
    sessionId,
    handoffToken,
    instanceId,
    sourcePaneId: search.get(names.sourcePaneId) ?? UNKNOWN_PANE,
    ...(toolKey ? { toolKey } : {}),
    ...(title !== null ? { title } : {}),
  };
}

export function readFileLaunchParams(
  search: URLSearchParams,
): FileLaunchParams | null {
  const names = LAUNCH_PARAM_NAMES.file;
  const documentId = search.get(names.documentId);
  const handoffToken = search.get(names.handoffToken);
  if (!documentId || !handoffToken) return null;
  return {
    ...fileContentRef(documentId),
    handoffToken,
    sourcePaneId: search.get(names.sourcePaneId) ?? UNKNOWN_PANE,
  };
}

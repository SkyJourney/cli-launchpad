import type { TFunction } from "i18next";
import { formatAppError } from "../../lib/appErrors";
import { sendContentHandoff } from "../../lib/workspaceContentWindowProtocol";
import type { RegisteredContentKind } from "../../generated/contentKinds";
import {
  fileContentKey,
  fileContentRef,
  ptyContentKey,
  ptyContentRef,
  type ManagedContentRef,
} from "../../lib/workspaceContentKey";

/**
 * Per-kind facts the detached-window protocol needs. Every registered content kind has exactly one
 * descriptor (`satisfies` below makes a missing kind a compile error), so the protocol modules read
 * these facts instead of spelling out `"pty"` or `"file"` themselves.
 */
export interface ContentProtocolDescriptor<K extends RegisteredContentKind> {
  readonly kind: K;
  /**
   * Field that carries the content identity on the handoff wire. It is kept per kind because the
   * PTY slot model already names its identity `instanceId`; the contract's `idField` is the
   * content-reference name and is checked by the descriptor test.
   */
  readonly wireIdField: "instanceId" | "documentId";
  refOf(id: string): Extract<ManagedContentRef, { kind: K }>;
  keyOf(id: string): string;
}

export const PTY_PROTOCOL: ContentProtocolDescriptor<"pty"> = {
  kind: "pty",
  wireIdField: "instanceId",
  refOf: ptyContentRef,
  keyOf: ptyContentKey,
};

export const FILE_PROTOCOL: ContentProtocolDescriptor<"file"> = {
  kind: "file",
  wireIdField: "documentId",
  refOf: fileContentRef,
  keyOf: fileContentKey,
};

/** One descriptor per registered kind; a kind added to the contract without one fails to compile. */
export type ContentProtocolTable = {
  [K in RegisteredContentKind]: ContentProtocolDescriptor<K>;
};

import { createContentWindowProtocol } from "./useContentWindowProtocol";
import { createPtyProtocolHandlers } from "./protocolHandlers.pty";
import { createFileProtocolHandlers } from "./protocolHandlers.file";
import type { ContentWindowOrchestrator } from "./contentWindowOrchestrator";
import type { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { workspaceContentKey } from "../../lib/workspaceContentKey";

/** The detached-window protocol of every registered kind, assembled from the kinds' handlers. */
export function createDetachedContentProtocol(
  orchestrator: ContentWindowOrchestrator,
  shell: Parameters<typeof createContentWindowProtocol>[0]["shell"],
) {
  return createContentWindowProtocol({
    pty: createPtyProtocolHandlers(orchestrator),
    file: createFileProtocolHandlers(orchestrator),
    shell,
  });
}

export const CONTENT_PROTOCOLS = {
  pty: PTY_PROTOCOL,
  file: FILE_PROTOCOL,
} as const satisfies ContentProtocolTable;

/** The descriptor of a registered kind; the lookup is total because of the table's type. */
export function contentProtocolOf<K extends RegisteredContentKind>(
  kind: K,
): (typeof CONTENT_PROTOCOLS)[K] {
  return CONTENT_PROTOCOLS[kind];
}

/** Asks the detached window that holds a content to hand it back to the pane it was dropped on. */
export function requestReturnDrop(
  windowLabel: string,
  content: ManagedContentRef,
  targetPaneId: string,
): Promise<void> {
  if (content.kind === "pty") {
    return sendContentHandoff(windowLabel, "pty", "return-drop-requested", {
      instanceId: content.slotId,
      targetPaneId,
    });
  }
  return sendContentHandoff(windowLabel, "file", "return-drop-requested", {
    documentId: content.documentId,
    targetPaneId,
  });
}

/** The user-facing text for a failed return drop; the terminal's wording wraps the reason. */
export function returnDropFailureMessage(
  content: ManagedContentRef,
  reason: unknown,
  t: TFunction,
): string {
  const detail = formatAppError(reason, t);
  return content.kind === "pty" ? t("pty.returnFailed", { error: detail }) : detail;
}

/** The window that holds a content, detached or still being detached; found by content reference. */
export function detachedWindowOf(
  state: ContentWindowOrchestrator["state"],
  content: ManagedContentRef,
): WebviewWindow | undefined {
  const key = workspaceContentKey(content);
  const handle = (state.handles[content.kind] as Map<string, WebviewWindow>).get(key);
  if (handle) return handle;
  return (state.pending[content.kind] as Map<string, { window: WebviewWindow }>).get(key)?.window;
}

/** Forgets the window handle of a content, found by content reference. */
export function forgetDetachedHandle(
  state: ContentWindowOrchestrator["state"],
  content: ManagedContentRef,
): void {
  (state.handles[content.kind] as Map<string, unknown>).delete(workspaceContentKey(content));
}

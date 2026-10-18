import type { WindowInboxSource, WorkspaceFileDocument } from "./tauri";
import type { Unlisten } from "./windowInbox";
import { onWindowMessage, sendWindowMessage } from "./windowMessages";
import type { WorkspaceFileBuffer } from "./workspaceFileBuffer";
import {
  windowKindOfContent,
  windowLabelPrefix,
  windowRoleOf,
  type DetachedWindowKind,
} from "./windowKinds";

export interface WorkspaceContentWindowEventPayloads {
  "pty-detached-ready": {
    instanceId: string;
    sessionId: string;
    windowLabel: string;
  };
  "pty-detached-failed": {
    instanceId: string;
    sessionId: string;
    windowLabel: string;
    message?: string;
  };
  "pty-return-requested": {
    instanceId: string;
    sessionId: string;
    windowLabel: string;
    token: string;
    targetPaneId?: string;
  };
  "pty-detached-exited": {
    instanceId: string;
    sessionId: string;
    windowLabel: string;
  };
  "pty-return-complete": {
    instanceId: string;
    token: string;
  };
  "pty-return-failed": {
    instanceId: string;
    token: string;
    message?: string;
  };
  "pty-return-drop-requested": {
    instanceId: string;
    targetPaneId?: string;
  };
  "workspace-file-window-ready": {
    documentId: string;
    token: string;
    windowLabel: string;
  };
  "workspace-file-window-attached": {
    documentId: string;
    token: string;
    windowLabel: string;
  };
  "workspace-file-window-attach-failed": {
    documentId: string;
    token: string;
    windowLabel: string;
    message?: string;
    reason?: "closed-before-ready";
  };
  "workspace-file-window-buffer-changed": {
    documentId: string;
    token: string;
    windowLabel: string;
    fileDocument?: WorkspaceFileDocument;
    fileBuffer?: WorkspaceFileBuffer;
  };
  "workspace-file-window-flush-requested": {
    documentId: string;
    token: string;
    windowLabel: string;
    requestId: string;
  };
  "workspace-file-window-flush-complete": {
    documentId: string;
    token: string;
    windowLabel: string;
    requestId: string;
    fileDocument: WorkspaceFileDocument;
    fileBuffer: WorkspaceFileBuffer;
  };
  "workspace-file-window-return-requested": {
    documentId: string;
    token: string;
    windowLabel: string;
    targetPaneId?: string;
    fileDocument?: WorkspaceFileDocument;
    fileBuffer?: WorkspaceFileBuffer;
  };
  "workspace-file-window-return-complete": {
    documentId: string;
    token: string;
  };
  "workspace-file-window-return-failed": {
    documentId: string;
    token: string;
    message?: string;
  };
  "workspace-file-window-return-drop-requested": {
    documentId: string;
    targetPaneId?: string;
  };
  "workspace-file-window-init": {
    documentId: string;
    token: string;
    windowLabel: string;
    fileDocument: WorkspaceFileDocument;
    fileBuffer: WorkspaceFileBuffer;
  };
}

export type WorkspaceContentWindowEventName =
  keyof WorkspaceContentWindowEventPayloads;

/**
 * 协议消息经 Rust 中继（m6-062）：发送用 `sendWindowMessage`，接收用 `onWindowMessage`，
 * 发送方由 Rust 盖戳。`handler` 的参数多出只读的 `source`。
 */
type EventHandler<Type extends WorkspaceContentWindowEventName> = (event: {
  payload: WorkspaceContentWindowEventPayloads[Type];
  source: WindowInboxSource;
}) => void | Promise<void>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasStringFields(
  value: Record<string, unknown>,
  fields: string[],
): boolean {
  return fields.every((field) => typeof value[field] === "string");
}

function hasOptionalStringFields(
  value: Record<string, unknown>,
  fields: string[],
): boolean {
  return fields.every(
    (field) => value[field] === undefined || typeof value[field] === "string",
  );
}

function isFileDocument(value: unknown): value is WorkspaceFileDocument {
  return (
    isRecord(value) &&
    hasStringFields(value, ["id", "directoryPath", "relativePath"]) &&
    typeof value.directoryId === "number" &&
    Number.isSafeInteger(value.directoryId) &&
    value.directoryId > 0
  );
}

function isFileBuffer(value: unknown): value is WorkspaceFileBuffer {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.epoch) &&
    Number(value.epoch) >= 0 &&
    Number.isSafeInteger(value.version) &&
    Number(value.version) >= 0 &&
    hasStringFields(value, ["content", "savedContent", "revision"]) &&
    typeof value.saving === "boolean" &&
    (value.kind === undefined ||
      value.kind === "text" ||
      value.kind === "image" ||
      value.kind === "unsupported") &&
    (value.conflict === undefined || typeof value.conflict === "boolean") &&
    (value.identityChanged === undefined ||
      typeof value.identityChanged === "boolean") &&
    (value.previewDataUrl === undefined ||
      typeof value.previewDataUrl === "string") &&
    (value.unsupportedReason === undefined ||
      ["binary", "tooLarge", "invalidImage", "unsupportedImage"].includes(
        String(value.unsupportedReason),
      ))
  );
}

function isValidEventPayload(
  type: WorkspaceContentWindowEventName,
  value: unknown,
): boolean {
  if (!isRecord(value)) return false;
  switch (type) {
    case "pty-detached-ready":
    case "pty-detached-exited":
      return hasStringFields(value, ["instanceId", "sessionId", "windowLabel"]);
    case "pty-detached-failed":
      return (
        hasStringFields(value, ["instanceId", "sessionId", "windowLabel"]) &&
        hasOptionalStringFields(value, ["message"])
      );
    case "pty-return-requested":
      return (
        hasStringFields(value, [
          "instanceId",
          "sessionId",
          "windowLabel",
          "token",
        ]) && hasOptionalStringFields(value, ["targetPaneId"])
      );
    case "pty-return-complete":
      return hasStringFields(value, ["instanceId", "token"]);
    case "pty-return-failed":
      return (
        hasStringFields(value, ["instanceId", "token"]) &&
        hasOptionalStringFields(value, ["message"])
      );
    case "pty-return-drop-requested":
      return (
        hasStringFields(value, ["instanceId"]) &&
        hasOptionalStringFields(value, ["targetPaneId"])
      );
    case "workspace-file-window-ready":
    case "workspace-file-window-attached":
      return hasStringFields(value, ["documentId", "token", "windowLabel"]);
    case "workspace-file-window-attach-failed":
      return (
        hasStringFields(value, ["documentId", "token", "windowLabel"]) &&
        hasOptionalStringFields(value, ["message", "reason"]) &&
        (value.reason === undefined || value.reason === "closed-before-ready")
      );
    case "workspace-file-window-buffer-changed":
      return (
        hasStringFields(value, ["documentId", "token", "windowLabel"]) &&
        (value.fileDocument === undefined ||
          isFileDocument(value.fileDocument)) &&
        (value.fileBuffer === undefined || isFileBuffer(value.fileBuffer))
      );
    case "workspace-file-window-flush-requested":
      return hasStringFields(value, [
        "documentId",
        "token",
        "windowLabel",
        "requestId",
      ]);
    case "workspace-file-window-flush-complete":
      return (
        hasStringFields(value, [
          "documentId",
          "token",
          "windowLabel",
          "requestId",
        ]) &&
        isFileDocument(value.fileDocument) &&
        isFileBuffer(value.fileBuffer)
      );
    case "workspace-file-window-return-requested":
      return (
        hasStringFields(value, ["documentId", "token", "windowLabel"]) &&
        hasOptionalStringFields(value, ["targetPaneId"]) &&
        (value.fileDocument === undefined ||
          isFileDocument(value.fileDocument)) &&
        (value.fileBuffer === undefined || isFileBuffer(value.fileBuffer))
      );
    case "workspace-file-window-return-complete":
      return hasStringFields(value, ["documentId", "token"]);
    case "workspace-file-window-return-failed":
      return (
        hasStringFields(value, ["documentId", "token"]) &&
        hasOptionalStringFields(value, ["message"])
      );
    case "workspace-file-window-return-drop-requested":
      return (
        hasStringFields(value, ["documentId"]) &&
        hasOptionalStringFields(value, ["targetPaneId"])
      );
    case "workspace-file-window-init":
      return (
        hasStringFields(value, ["documentId", "token", "windowLabel"]) &&
        isFileDocument(value.fileDocument) &&
        isFileBuffer(value.fileBuffer)
      );
  }
}

export function isWorkspaceContentWindowEventName(
  value: unknown,
): value is WorkspaceContentWindowEventName {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(
      workspaceContentWindowEventPayloadKeys,
      value,
    )
  );
}

const workspaceContentWindowEventPayloadKeys: Record<
  WorkspaceContentWindowEventName,
  true
> = {
  "pty-detached-ready": true,
  "pty-detached-failed": true,
  "pty-return-requested": true,
  "pty-detached-exited": true,
  "pty-return-complete": true,
  "pty-return-failed": true,
  "pty-return-drop-requested": true,
  "workspace-file-window-ready": true,
  "workspace-file-window-attached": true,
  "workspace-file-window-attach-failed": true,
  "workspace-file-window-buffer-changed": true,
  "workspace-file-window-flush-requested": true,
  "workspace-file-window-flush-complete": true,
  "workspace-file-window-return-requested": true,
  "workspace-file-window-return-complete": true,
  "workspace-file-window-return-failed": true,
  "workspace-file-window-return-drop-requested": true,
  "workspace-file-window-init": true,
};

/** The message types of the protocol (the contract test compares them with window-messages.json). */
export const WORKSPACE_CONTENT_WINDOW_MESSAGE_TYPES = Object.keys(
  workspaceContentWindowEventPayloadKeys,
) as WorkspaceContentWindowEventName[];

export function listenWorkspaceContentWindowEvent<
  Type extends WorkspaceContentWindowEventName,
>(type: Type, handler: EventHandler<Type>): Promise<Unlisten> {
  return onWindowMessage<unknown>(type, (event) => {
    if (!isValidEventPayload(type, event.payload)) return;
    // A window may only speak for itself: when a child window claims a label, it must be its own
    // (stamped) label. Messages from the main window address the receiver and are not checked.
    const claimed = (event.payload as { windowLabel?: unknown }).windowLabel;
    if (
      event.source.kind !== "main" &&
      typeof claimed === "string" &&
      claimed !== event.source.label
    ) {
      console.warn("workspace_content_event.source_mismatch", type);
      return;
    }
    return handler({
      payload: event.payload as WorkspaceContentWindowEventPayloads[Type],
      source: event.source,
    });
  });
}

export function emitWorkspaceContentWindowEvent<
  Type extends WorkspaceContentWindowEventName,
>(
  target: string,
  type: Type,
  payload: WorkspaceContentWindowEventPayloads[Type],
): Promise<void> {
  return sendWindowMessage(target, type, payload).then((delivered) => {
    if (!delivered) console.warn("window_message.target_unavailable", type);
  });
}

export function getWorkspaceContentWindowLabelPrefix(
  kind: "pty" | "file",
): "terminal-" | "workspace-content-" {
  const windowKind = windowKindOfContent(kind);
  if (!windowKind || windowRoleOf(windowKind).primary) {
    throw new Error(`内容类型没有对应的独立窗口类别：${kind}`);
  }
  return windowLabelPrefix(windowKind as DetachedWindowKind) as
    | "terminal-"
    | "workspace-content-";
}

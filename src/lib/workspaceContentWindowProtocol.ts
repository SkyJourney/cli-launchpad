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

/**
 * Payloads of the content handoff protocol, grouped by content kind and phase. The phase names
 * are the suffixes of the generic message types `content-handoff-<phase>` (m6-091).
 */
export interface ContentHandoffPayloads {
  pty: {
    ready: { instanceId: string; sessionId: string; windowLabel: string };
    failed: {
      instanceId: string;
      sessionId: string;
      windowLabel: string;
      message?: string;
    };
    exited: { instanceId: string; sessionId: string; windowLabel: string };
    "return-requested": {
      instanceId: string;
      sessionId: string;
      windowLabel: string;
      /** The return's transfer id, issued by the child window. */
      token: string;
      /** The Rust handoff token; the main window attaches the PTY with it. */
      handoffToken: string;
      targetPaneId?: string;
    };
    "return-complete": { instanceId: string; token: string };
    "return-failed": { instanceId: string; token: string; message?: string };
    "return-drop-requested": { instanceId: string; targetPaneId?: string };
  };
  file: {
    ready: { documentId: string; token: string; windowLabel: string };
    attached: { documentId: string; token: string; windowLabel: string };
    failed: {
      documentId: string;
      token: string;
      windowLabel: string;
      message?: string;
      reason?: "closed-before-ready";
    };
    "state-changed": {
      documentId: string;
      token: string;
      windowLabel: string;
      fileDocument?: WorkspaceFileDocument;
      fileBuffer?: WorkspaceFileBuffer;
    };
    "flush-requested": {
      documentId: string;
      token: string;
      windowLabel: string;
      requestId: string;
    };
    "flush-complete": {
      documentId: string;
      token: string;
      windowLabel: string;
      requestId: string;
      fileDocument: WorkspaceFileDocument;
      fileBuffer: WorkspaceFileBuffer;
    };
    "return-requested": {
      documentId: string;
      token: string;
      windowLabel: string;
      targetPaneId?: string;
      fileDocument?: WorkspaceFileDocument;
      fileBuffer?: WorkspaceFileBuffer;
    };
    "return-complete": { documentId: string; token: string };
    "return-failed": { documentId: string; token: string; message?: string };
    "return-drop-requested": { documentId: string; targetPaneId?: string };
    init: {
      documentId: string;
      token: string;
      windowLabel: string;
      fileDocument: WorkspaceFileDocument;
      fileBuffer: WorkspaceFileBuffer;
    };
  };
}

export type ContentHandoffKind = keyof ContentHandoffPayloads;
export type ContentHandoffPhase<
  K extends ContentHandoffKind = ContentHandoffKind,
> = keyof ContentHandoffPayloads[K] & string;

export const CONTENT_HANDOFF_PHASES = {
  pty: [
    "exited",
    "failed",
    "ready",
    "return-complete",
    "return-drop-requested",
    "return-failed",
    "return-requested",
  ],
  file: [
    "attached",
    "failed",
    "flush-complete",
    "flush-requested",
    "init",
    "ready",
    "return-complete",
    "return-drop-requested",
    "return-failed",
    "return-requested",
    "state-changed",
  ],
} as const satisfies {
  [K in ContentHandoffKind]: readonly ContentHandoffPhase<K>[];
};

const CONTENT_HANDOFF_IDENTITY = {
  pty: { idField: "instanceId" },
  file: { idField: "documentId" },
} as const satisfies Record<ContentHandoffKind, { idField: string }>;

export const CONTENT_HANDOFF_MESSAGE_PREFIX = "content-handoff-";

export function contentHandoffMessageType(phase: string): string {
  return `${CONTENT_HANDOFF_MESSAGE_PREFIX}${phase}`;
}

export const CONTENT_HANDOFF_MESSAGE_TYPES: readonly string[] = [
  ...new Set([...CONTENT_HANDOFF_PHASES.pty, ...CONTENT_HANDOFF_PHASES.file]),
]
  .sort()
  .map(contentHandoffMessageType);

/** The inner `payload` of a generic envelope: the content identity and the transfer token are lifted out. */
export interface ContentHandoffWirePayload {
  content: { kind: ContentHandoffKind; id: string };
  transferId: string | null;
  payload: Record<string, unknown>;
}

export function encodeContentHandoff(
  kind: ContentHandoffKind,
  payload: Record<string, unknown>,
): ContentHandoffWirePayload {
  const { idField } = CONTENT_HANDOFF_IDENTITY[kind];
  const { [idField]: id, token, ...rest } = payload;
  if (typeof id !== "string" || id === "") {
    throw new Error(`Content handoff payload has no ${idField}`);
  }
  return {
    content: { kind, id },
    transferId: typeof token === "string" ? token : null,
    payload: rest,
  };
}

export function decodeContentHandoff(
  kind: ContentHandoffKind,
  wire: unknown,
): Record<string, unknown> | null {
  if (!isRecord(wire) || !isRecord(wire.content) || !isRecord(wire.payload))
    return null;
  const { idField } = CONTENT_HANDOFF_IDENTITY[kind];
  const { content, transferId, payload } = wire;
  if (content.kind !== kind) return null;
  if (typeof content.id !== "string" || content.id === "") return null;
  if (transferId !== null && typeof transferId !== "string") return null;
  if (idField in payload || "token" in payload) return null;
  return {
    ...payload,
    [idField]: content.id,
    ...(transferId === null ? {} : { token: transferId }),
  };
}

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

/** Per-kind payload validation: `kind:phase` selects the rules that used to be keyed by message type. */
function isValidHandoffPayload(
  kind: ContentHandoffKind,
  phase: string,
  value: unknown,
): boolean {
  if (!isRecord(value)) return false;
  switch (`${kind}:${phase}`) {
    case "pty:ready":
    case "pty:exited":
      return hasStringFields(value, ["instanceId", "sessionId", "windowLabel"]);
    case "pty:failed":
      return (
        hasStringFields(value, ["instanceId", "sessionId", "windowLabel"]) &&
        hasOptionalStringFields(value, ["message"])
      );
    case "pty:return-requested":
      return (
        hasStringFields(value, [
          "instanceId",
          "sessionId",
          "windowLabel",
          "token",
          "handoffToken",
        ]) &&
        typeof value.handoffToken === "string" &&
        value.handoffToken.length > 0 &&
        hasOptionalStringFields(value, ["targetPaneId"])
      );
    case "pty:return-complete":
      return hasStringFields(value, ["instanceId", "token"]);
    case "pty:return-failed":
      return (
        hasStringFields(value, ["instanceId", "token"]) &&
        hasOptionalStringFields(value, ["message"])
      );
    case "pty:return-drop-requested":
      return (
        hasStringFields(value, ["instanceId"]) &&
        hasOptionalStringFields(value, ["targetPaneId"])
      );
    case "file:ready":
    case "file:attached":
      return hasStringFields(value, ["documentId", "token", "windowLabel"]);
    case "file:failed":
      return (
        hasStringFields(value, ["documentId", "token", "windowLabel"]) &&
        hasOptionalStringFields(value, ["message", "reason"]) &&
        (value.reason === undefined || value.reason === "closed-before-ready")
      );
    case "file:state-changed":
      return (
        hasStringFields(value, ["documentId", "token", "windowLabel"]) &&
        (value.fileDocument === undefined ||
          isFileDocument(value.fileDocument)) &&
        (value.fileBuffer === undefined || isFileBuffer(value.fileBuffer))
      );
    case "file:flush-requested":
      return hasStringFields(value, [
        "documentId",
        "token",
        "windowLabel",
        "requestId",
      ]);
    case "file:flush-complete":
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
    case "file:return-requested":
      return (
        hasStringFields(value, ["documentId", "token", "windowLabel"]) &&
        hasOptionalStringFields(value, ["targetPaneId"]) &&
        (value.fileDocument === undefined ||
          isFileDocument(value.fileDocument)) &&
        (value.fileBuffer === undefined || isFileBuffer(value.fileBuffer))
      );
    case "file:return-complete":
      return hasStringFields(value, ["documentId", "token"]);
    case "file:return-failed":
      return (
        hasStringFields(value, ["documentId", "token"]) &&
        hasOptionalStringFields(value, ["message"])
      );
    case "file:return-drop-requested":
      return (
        hasStringFields(value, ["documentId"]) &&
        hasOptionalStringFields(value, ["targetPaneId"])
      );
    case "file:init":
      return (
        hasStringFields(value, ["documentId", "token", "windowLabel"]) &&
        isFileDocument(value.fileDocument) &&
        isFileBuffer(value.fileBuffer)
      );
    default:
      return false;
  }
}

/**
 * Subscribes to one content handoff phase of one kind. A message of the same phase but another
 * kind is ignored silently: that is normal, not an error.
 */
export function onContentHandoff<
  K extends ContentHandoffKind,
  P extends ContentHandoffPhase<K>,
>(
  kind: K,
  phase: P,
  handler: (event: {
    payload: ContentHandoffPayloads[K][P];
    source: WindowInboxSource;
  }) => void | Promise<void>,
): Promise<Unlisten> {
  const type = contentHandoffMessageType(phase);
  return onWindowMessage<unknown>(type, (event) => {
    const decoded = decodeContentHandoff(kind, event.payload);
    if (decoded === null) return;
    if (!isValidHandoffPayload(kind, phase, decoded)) return;
    // A window may only speak for itself: when a child window claims a label, it must be its own
    // (stamped) label. Messages from the main window address the receiver and are not checked.
    const claimed = decoded.windowLabel;
    if (
      event.source.kind !== "main" &&
      typeof claimed === "string" &&
      claimed !== event.source.label
    ) {
      console.warn("workspace_content_event.source_mismatch", type);
      return;
    }
    return handler({
      payload: decoded as ContentHandoffPayloads[K][P],
      source: event.source,
    });
  });
}

/** Sends one content handoff phase to a window. An unavailable target only logs a warning. */
export function sendContentHandoff<
  K extends ContentHandoffKind,
  P extends ContentHandoffPhase<K>,
>(
  target: string,
  kind: K,
  phase: P,
  payload: ContentHandoffPayloads[K][P],
): Promise<void> {
  const type = contentHandoffMessageType(phase);
  return sendWindowMessage(
    target,
    type,
    encodeContentHandoff(kind, payload as unknown as Record<string, unknown>),
  ).then((delivered) => {
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

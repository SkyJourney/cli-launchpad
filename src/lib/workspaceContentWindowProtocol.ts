import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { WorkspaceFileDocument } from "./tauri";
import type { WorkspaceFileBuffer } from "./workspaceFileBuffer";

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
  };
  "workspace-file-window-buffer-changed": {
    documentId: string;
    token: string;
    windowLabel: string;
    fileDocument?: WorkspaceFileDocument;
    fileBuffer?: WorkspaceFileBuffer;
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

export const WORKSPACE_CONTENT_WINDOW_EVENT = "workspace-content-window-event";
const PROTOCOL_VERSION = 1 as const;

type WorkspaceContentWindowEnvelope = {
  [Type in WorkspaceContentWindowEventName]: {
    apiVersion: typeof PROTOCOL_VERSION;
    type: Type;
    payload: WorkspaceContentWindowEventPayloads[Type];
  };
}[WorkspaceContentWindowEventName];

type EventHandler<Type extends WorkspaceContentWindowEventName> = (event: {
  payload: WorkspaceContentWindowEventPayloads[Type];
}) => void;

interface Subscriber {
  type: WorkspaceContentWindowEventName;
  handler: (payload: unknown) => void | Promise<void>;
}

const subscribers = new Set<Subscriber>();
let unlistenProtocol: UnlistenFn | null = null;
let protocolRegistration: Promise<void> | null = null;

async function ensureProtocolListener(): Promise<void> {
  if (unlistenProtocol || protocolRegistration) {
    await protocolRegistration;
    return;
  }
  protocolRegistration = listen<WorkspaceContentWindowEnvelope>(
    WORKSPACE_CONTENT_WINDOW_EVENT,
    ({ payload }) => {
      if (
        !payload ||
        payload.apiVersion !== PROTOCOL_VERSION ||
        typeof payload.type !== "string"
      ) {
        return;
      }
      for (const subscriber of subscribers) {
        if (subscriber.type === payload.type) {
          Promise.resolve(
            subscriber.handler({ payload: payload.payload }),
          ).catch((reason) =>
            console.error(
              `Workspace content event handler failed: ${payload.type}`,
              reason,
            ),
          );
        }
      }
    },
  )
    .then((stop) => {
      if (subscribers.size === 0) stop();
      else unlistenProtocol = stop;
    })
    .finally(() => {
      protocolRegistration = null;
    });
  await protocolRegistration;
}

export async function listenWorkspaceContentWindowEvent<
  Type extends WorkspaceContentWindowEventName,
>(type: Type, handler: EventHandler<Type>): Promise<UnlistenFn> {
  const subscriber: Subscriber = {
    type,
    handler: handler as (payload: unknown) => void | Promise<void>,
  };
  subscribers.add(subscriber);
  try {
    await ensureProtocolListener();
  } catch (reason) {
    subscribers.delete(subscriber);
    throw reason;
  }
  return () => {
    subscribers.delete(subscriber);
    if (subscribers.size === 0) {
      unlistenProtocol?.();
      unlistenProtocol = null;
    }
  };
}

export function emitWorkspaceContentWindowEvent<
  Type extends WorkspaceContentWindowEventName,
>(
  target: string,
  type: Type,
  payload: WorkspaceContentWindowEventPayloads[Type],
): Promise<void> {
  return emitTo(target, WORKSPACE_CONTENT_WINDOW_EVENT, {
    apiVersion: PROTOCOL_VERSION,
    type,
    payload,
  } as Extract<WorkspaceContentWindowEnvelope, { type: Type }>);
}

export function getWorkspaceContentWindowLabelPrefix(
  kind: "pty" | "file",
): "terminal-" | "workspace-content-" {
  return kind === "pty" ? "terminal-" : "workspace-content-";
}

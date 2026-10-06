import type { WorkspaceFileDocument } from "./tauri";
import type { WorkspaceFileBuffer } from "./workspaceFileBuffer";

export interface WorkspaceFileFlushTarget {
  documentId: string;
  token: string;
  windowLabel: string;
}

export interface WorkspaceFileFlushResponse extends WorkspaceFileFlushTarget {
  requestId: string;
  fileDocument: WorkspaceFileDocument;
  fileBuffer: WorkspaceFileBuffer;
}

/** Requests the child window's current mirror, returning null on timeout/failure. */
export function requestWorkspaceFileBufferFlush(args: {
  target: WorkspaceFileFlushTarget;
  listen: (
    handler: (response: WorkspaceFileFlushResponse) => void,
  ) => Promise<() => void>;
  emit: (requestId: string) => Promise<void>;
  timeoutMs?: number;
}): Promise<WorkspaceFileFlushResponse | null> {
  const timeoutMs = args.timeoutMs ?? 500;

  return new Promise((resolve) => {
    let requestId: string;
    try {
      requestId = crypto.randomUUID();
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    let unlisten: (() => void) | undefined;
    const finish = (response: WorkspaceFileFlushResponse | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      unlisten?.();
      resolve(response);
    };
    const timeout = setTimeout(() => finish(null), timeoutMs);

    void Promise.resolve()
      .then(() =>
        args.listen((response) => {
          if (
            response.requestId !== requestId ||
            response.documentId !== args.target.documentId ||
            response.token !== args.target.token ||
            response.windowLabel !== args.target.windowLabel ||
            response.fileDocument.id !== args.target.documentId
          ) {
            return;
          }
          finish(response);
        }),
      )
      .then((stop) => {
        if (settled) {
          stop();
          return;
        }
        unlisten = stop;
        return args.emit(requestId).catch(() => finish(null));
      })
      .catch(() => finish(null));
  });
}

import type { ProjectFileOpenResult, WorkspaceFileDocument } from "./tauri";

export function workspaceFileDocumentIdentityMatches(
  known: WorkspaceFileDocument | undefined,
  incoming: WorkspaceFileDocument | undefined,
): boolean {
  return (
    known !== undefined &&
    incoming !== undefined &&
    incoming.id === known.id &&
    incoming.directoryId === known.directoryId &&
    incoming.directoryPath === known.directoryPath &&
    incoming.relativePath === known.relativePath
  );
}

export interface WorkspaceFileBuffer {
  kind?: "text" | "image" | "unsupported";
  /** Increases only when a fresh disk snapshot replaces this document. */
  epoch: number;
  /** Monotonic version for edits and asynchronous save state transitions. */
  version: number;
  content: string;
  savedContent: string;
  revision: string;
  saving: boolean;
  conflict?: boolean;
  identityChanged?: boolean;
  previewDataUrl?: string;
  unsupportedReason?: Extract<
    ProjectFileOpenResult,
    { kind: "unsupported" }
  >["reason"];
}

export function createWorkspaceFileBuffer(
  file: ProjectFileOpenResult,
  epoch = 0,
): WorkspaceFileBuffer {
  if (file.kind === "text") {
    return {
      kind: "text",
      epoch,
      version: 0,
      content: file.content,
      savedContent: file.content,
      revision: file.revision,
      saving: false,
      conflict: false,
    };
  }
  if (file.kind === "image") {
    return {
      kind: "image",
      epoch,
      version: 0,
      content: "",
      savedContent: "",
      revision: "",
      saving: false,
      previewDataUrl: `data:${file.mimeType};base64,${file.base64Data}`,
    };
  }
  return {
    kind: "unsupported",
    epoch,
    version: 0,
    content: "",
    savedContent: "",
    revision: "",
    saving: false,
    unsupportedReason: file.reason,
  };
}

export function editWorkspaceFileBuffer(
  current: WorkspaceFileBuffer,
  content: string,
): WorkspaceFileBuffer {
  if (current.content === content) return current;
  return {
    ...current,
    content,
    version: current.version + 1,
    conflict: false,
  };
}

export function beginWorkspaceFileSave(
  current: WorkspaceFileBuffer,
): WorkspaceFileBuffer {
  return { ...current, saving: true, version: current.version + 1 };
}

export function isWorkspaceFileBufferNewer(
  candidate: WorkspaceFileBuffer,
  current: WorkspaceFileBuffer | undefined,
): boolean {
  return (
    !current ||
    candidate.epoch > current.epoch ||
    (candidate.epoch === current.epoch && candidate.version > current.version)
  );
}

export interface WorkspaceFileSaveResult {
  content: string;
  revision: string;
  warning?: "permissionsNotRestored" | null;
}

export type WorkspaceFileSaveCommitDisposition =
  | "apply-result"
  | "restore-saving-state"
  | "discard-result";

export function resolveWorkspaceFileSaveCommitDisposition(
  current: WorkspaceFileBuffer | undefined,
  submitted: WorkspaceFileBuffer,
  documentIdentityMatches: boolean,
): WorkspaceFileSaveCommitDisposition {
  if (!current || current.epoch !== submitted.epoch) return "discard-result";
  if (documentIdentityMatches) return "apply-result";
  if (current.saving && current.version === submitted.version) {
    return "restore-saving-state";
  }
  return "discard-result";
}

export function completeWorkspaceFileSave(
  current: WorkspaceFileBuffer | undefined,
  submitted: WorkspaceFileBuffer,
  result: WorkspaceFileSaveResult,
): WorkspaceFileBuffer {
  if (!current || current.epoch !== submitted.epoch)
    return current ?? submitted;
  return {
    ...current,
    content:
      current.version !== submitted.version ? current.content : result.content,
    savedContent: result.content,
    revision: result.revision,
    saving: false,
    conflict: false,
    version: current.version + 1,
  };
}

export function markWorkspaceFileSaveConflict(
  current: WorkspaceFileBuffer | undefined,
  submitted: WorkspaceFileBuffer,
): WorkspaceFileBuffer {
  if (!current || current.epoch !== submitted.epoch)
    return current ?? submitted;
  return {
    ...current,
    saving: false,
    conflict: true,
    version: current.version + 1,
  };
}

export function failWorkspaceFileSave(
  current: WorkspaceFileBuffer | undefined,
  submitted: WorkspaceFileBuffer,
): WorkspaceFileBuffer {
  if (!current || current.epoch !== submitted.epoch)
    return current ?? submitted;
  return { ...current, saving: false, version: current.version + 1 };
}

export function markWorkspaceFileIdentityChanged(
  current: WorkspaceFileBuffer,
): WorkspaceFileBuffer {
  return {
    ...current,
    saving: false,
    conflict: true,
    identityChanged: true,
    version: current.version + 1,
  };
}

/** Coalesces concurrent operations for one document without sharing state. */
export class WorkspaceFileOperationFlights {
  private readonly loads = new Map<string, Promise<unknown>>();
  private readonly saves = new Map<string, Promise<void>>();

  load<T>(documentId: string, operation: () => Promise<T>): Promise<T> {
    const existing = this.loads.get(documentId);
    if (existing) return existing as Promise<T>;
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const pending = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    this.loads.set(documentId, pending);
    void pending.then(
      () => {
        if (this.loads.get(documentId) === pending)
          this.loads.delete(documentId);
      },
      () => {
        if (this.loads.get(documentId) === pending)
          this.loads.delete(documentId);
      },
    );
    try {
      Promise.resolve(operation()).then(resolve, reject);
    } catch (reason) {
      reject(reason);
    }
    return pending;
  }

  save(documentId: string, operation: () => Promise<void>): Promise<void> {
    const existing = this.saves.get(documentId);
    if (existing) return existing;
    let resolve!: () => void;
    let reject!: (reason?: unknown) => void;
    const pending = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    this.saves.set(documentId, pending);
    void pending.then(
      () => {
        if (this.saves.get(documentId) === pending)
          this.saves.delete(documentId);
      },
      () => {
        if (this.saves.get(documentId) === pending)
          this.saves.delete(documentId);
      },
    );
    try {
      Promise.resolve(operation()).then(resolve, reject);
    } catch (reason) {
      reject(reason);
    }
    return pending;
  }

  waitForSave(documentId: string): Promise<void> {
    return this.saves.get(documentId) ?? Promise.resolve();
  }

  isSaving(documentId: string): boolean {
    return this.saves.has(documentId);
  }
}

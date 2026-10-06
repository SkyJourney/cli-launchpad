import type { WorkspaceFileDocument } from "./tauri";
import type { WorkspaceFileBuffer } from "./workspaceFileBuffer";

export interface AppExitImpacts {
  ptyCount: number;
  dirtyFiles: Array<{ documentId: string; relativePath: string }>;
}

export function shouldExitWithoutPrompt(impacts: AppExitImpacts): boolean {
  return impacts.ptyCount === 0 && impacts.dirtyFiles.length === 0;
}

export function collectAppExitImpacts(args: {
  ptyCount: number;
  documents: WorkspaceFileDocument[];
  buffers: Record<string, WorkspaceFileBuffer>;
  uncertainDocumentIds?: Iterable<string>;
}): AppExitImpacts {
  const uncertain = new Set(args.uncertainDocumentIds ?? []);
  const dirtyFiles = new Map<
    string,
    { documentId: string; relativePath: string }
  >();

  for (const document of args.documents) {
    const buffer = args.buffers[document.id];
    const dirty =
      uncertain.has(document.id) ||
      (buffer?.kind === "text" &&
        (buffer.saving ||
          buffer.identityChanged === true ||
          buffer.conflict === true ||
          buffer.content !== buffer.savedContent));
    if (dirty) {
      dirtyFiles.set(document.id, {
        documentId: document.id,
        relativePath: document.relativePath,
      });
    }
  }

  for (const documentId of uncertain) {
    if (dirtyFiles.has(documentId)) continue;
    const document = args.documents.find((entry) => entry.id === documentId);
    dirtyFiles.set(documentId, {
      documentId,
      relativePath: document?.relativePath ?? documentId,
    });
  }

  return {
    ptyCount: Math.max(0, args.ptyCount),
    dirtyFiles: [...dirtyFiles.values()],
  };
}

import type { WorkspaceFileDocument } from "./tauri";
import {
  isWorkspaceFileBufferDirty,
  isWorkspaceFileBufferNewer,
  type WorkspaceFileBuffer,
} from "./workspaceFileBuffer";

export interface AppExitImpacts {
  ptyCount: number;
  dirtyFiles: Array<{ documentId: string; relativePath: string }>;
}

/**
 * 退出对话框使用的请求：在退出影响之上附带 Rust 计算的活动执行任务数，以及该次请求的 id。
 * 确认时只能回传这个 id（对话框展示什么，就确认什么），不得读取最新收到的请求 id。
 */
export interface AppExitRequest extends AppExitImpacts {
  requestId: string;
  executionTaskCount: number;
}

/**
 * The single "is there anything the user must be asked about?" rule (m6-095). The exit prompt and
 * the impact summaries both decide through it.
 */
export function hasExitImpacts(counts: {
  ptyCount: number;
  dirtyFileCount: number;
  executionTaskCount: number;
}): boolean {
  return (
    counts.ptyCount > 0 ||
    counts.dirtyFileCount > 0 ||
    counts.executionTaskCount > 0
  );
}

export function shouldExitWithoutPrompt(
  impacts: AppExitImpacts & { executionTaskCount?: number },
): boolean {
  return !hasExitImpacts({
    ptyCount: impacts.ptyCount,
    dirtyFileCount: impacts.dirtyFiles.length,
    executionTaskCount: impacts.executionTaskCount ?? 0,
  });
}

/** One window's answer to the exit flush request. `response` is null when the window did not answer in time. */
export interface ExitFlushOutcome {
  documentId: string;
  response: {
    fileDocument: WorkspaceFileDocument;
    fileBuffer: WorkspaceFileBuffer;
  } | null;
}

/**
 * Merges the flush answers into the host buffers. A newer buffer from a window that still holds
 * the same document replaces the host buffer; an answer that is missing or belongs to another
 * project file marks the document as uncertain. Returns the input `buffers` object unchanged
 * (same reference) when nothing was replaced.
 */
export function mergeExitFlushResults(args: {
  documents: readonly WorkspaceFileDocument[];
  buffers: Record<string, WorkspaceFileBuffer>;
  outcomes: readonly ExitFlushOutcome[];
}): {
  buffers: Record<string, WorkspaceFileBuffer>;
  uncertainDocumentIds: string[];
} {
  const uncertainDocumentIds: string[] = [];
  let nextBuffers = args.buffers;
  for (const { documentId, response } of args.outcomes) {
    const currentDocument = args.documents.find(
      (document) => document.id === documentId,
    );
    if (
      !response ||
      !currentDocument ||
      response.fileDocument.directoryId !== currentDocument.directoryId ||
      response.fileDocument.directoryPath !== currentDocument.directoryPath ||
      response.fileDocument.relativePath !== currentDocument.relativePath
    ) {
      uncertainDocumentIds.push(documentId);
      continue;
    }
    if (
      isWorkspaceFileBufferNewer(response.fileBuffer, nextBuffers[documentId])
    ) {
      if (nextBuffers === args.buffers) {
        nextBuffers = { ...args.buffers };
      }
      nextBuffers[documentId] = response.fileBuffer;
    }
  }
  return { buffers: nextBuffers, uncertainDocumentIds };
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
      uncertain.has(document.id) || isWorkspaceFileBufferDirty(buffer);
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

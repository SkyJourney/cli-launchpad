import { isWorkspaceFileBufferDirty } from "../../lib/workspaceFileBuffer";
import type { WorkspaceHostStore } from "../host/workspaceHostStore";
import type { FileDocumentsDomain } from "./fileDocumentsDomain";
import type {
  WorkspaceContentDomain,
  WorkspaceContentRefOf,
  WorkspaceCloseInput,
} from "./workspaceDomainTable";

export interface FileContentDomainDeps {
  store: WorkspaceHostStore;
  fileDomain: Pick<FileDocumentsDomain, "closeDocuments">;
  isWindowOwned: (ref: WorkspaceContentRefOf<"file">) => boolean;
  isHandoffActive: (ref: WorkspaceContentRefOf<"file">) => boolean;
}

export function createFileContentDomain(
  deps: FileContentDomainDeps,
): WorkspaceContentDomain<"file"> {
  return {
    kind: "file",
    closeInput: (ref): WorkspaceCloseInput | undefined => {
      const live = deps.store.getLive();
      const document = live.documents.find(
        (entry) => entry.id === ref.documentId,
      );
      if (!document || deps.isWindowOwned(ref) || deps.isHandoffActive(ref)) {
        return undefined;
      }
      const buffer = live.buffers[ref.documentId];
      const isDirty = isWorkspaceFileBufferDirty(buffer);
      return { title: document.relativePath, isDirty, isRunning: false };
    },
    close: async (refs) => {
      const { closedDocumentIds } = deps.fileDomain.closeDocuments(
        refs.map((ref) => ref.documentId),
      );
      return {
        closed: closedDocumentIds.map((documentId) => ({
          kind: "file" as const,
          documentId,
        })),
        pending: [],
        failed: [],
      };
    },
  };
}

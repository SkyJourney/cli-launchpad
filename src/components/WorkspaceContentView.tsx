import { useSyncExternalStore } from "react";
import type { WorkspacePaneContentRef } from "../lib/tauri";
import type { WorkspaceFileDocument } from "../lib/tauri";
import type { WorkspaceFileBuffer } from "../lib/workspaceFileBuffer";
import {
  getWorkspaceContentAdapter,
  getWorkspaceContentAdapterRevision,
  subscribeWorkspaceContentAdapters,
} from "./workspaceContentAdapterRegistry";
import { registerBuiltinWorkspaceContentAdapters } from "./workspaceContentAdapters/builtins";

const unregisterBuiltins = registerBuiltinWorkspaceContentAdapters();

export {
  getWorkspaceContentAdapter,
  registerWorkspaceContentAdapter,
} from "./workspaceContentAdapterRegistry";
export type {
  WorkspaceContentAdapter,
  WorkspaceContentAdapterLabels,
  WorkspaceContentAdapterLifecycle,
  WorkspaceContentHandoffHookContext,
  WorkspaceContentRenderContext,
} from "./workspaceContentAdapterRegistry";

export function WorkspaceContentView({
  content,
  fileDocument,
  fileBuffer,
  ptyPortalTarget,
  onEditFile,
  onSaveFile,
}: {
  content: WorkspacePaneContentRef | null | undefined;
  fileDocument: WorkspaceFileDocument | undefined;
  fileBuffer: WorkspaceFileBuffer | undefined;
  ptyPortalTarget?: HTMLElement;
  onEditFile: (documentId: string, content: string) => void;
  onSaveFile: (documentId: string) => Promise<void>;
}) {
  useSyncExternalStore(
    subscribeWorkspaceContentAdapters,
    getWorkspaceContentAdapterRevision,
    getWorkspaceContentAdapterRevision,
  );
  if (!content) return null;
  const adapter = getWorkspaceContentAdapter(content.kind);
  return adapter.render({
    content,
    ...(content.kind === "pty"
      ? { pty: { portalTarget: ptyPortalTarget } }
      : {}),
    ...(content.kind === "file"
      ? {
          file: {
            document: fileDocument,
            buffer: fileBuffer,
            edit: onEditFile,
            save: onSaveFile,
          },
        }
      : {}),
  });
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => unregisterBuiltins());
}

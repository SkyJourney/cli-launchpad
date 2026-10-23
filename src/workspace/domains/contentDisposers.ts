import { tryGetWorkspaceContentAdapter } from "../../components/workspaceContentAdapterRegistry";
import { fileContentRef } from "../../lib/workspaceContentKey";
import { MAIN_WINDOW_LABEL } from "../../lib/windowKinds";

/**
 * Releases file documents that the main window no longer keeps. Lives in the domain layer so the
 * host runtime does not name a content kind; the adapter registry decides what disposal means.
 */
export function releaseFileDocuments(documentIds: readonly string[]): void {
  if (documentIds.length === 0) return;
  const dispose = tryGetWorkspaceContentAdapter("file")?.lifecycle?.dispose;
  if (!dispose) return;
  for (const documentId of documentIds) {
    void (async () => {
      try {
        await dispose({
          content: fileContentRef(documentId),
          owner: { kind: "window", windowLabel: MAIN_WINDOW_LABEL },
          generation: 0,
          reason: "ownerEnded",
        });
      } catch (error) {
        console.error("Workspace file document release failed", error);
      }
    })();
  }
}

/** The adapter-provided disposal of PTY content; the host passes it to the close path. */
export function ptyContentDisposer() {
  return tryGetWorkspaceContentAdapter("pty")?.lifecycle?.dispose;
}

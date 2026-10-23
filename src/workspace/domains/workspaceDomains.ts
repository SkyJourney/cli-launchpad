import type { PtyContentDomainDeps } from "./ptyContentDomain";
import type { FileContentDomainDeps } from "./fileContentDomain";
import { createFileContentDomain } from "./fileContentDomain";
import { createPtyContentDomain } from "./ptyContentDomain";
import {
  createWorkspaceDomainTable,
  type WorkspaceDomainTable,
} from "./workspaceDomainTable";
import type { WorkspaceHostStore } from "../host/workspaceHostStore";
import type { WorkspacePaneContentRef } from "../../lib/tauri";

/**
 * Everything the close domains of all content kinds need. The host supplies one bag and names no
 * content kind; the per-kind wiring lives here in the domain layer.
 */
export interface WorkspaceDomainDeps {
  store: WorkspaceHostStore;
  fileDomain: FileContentDomainDeps["fileDomain"];
  terminalRefs: PtyContentDomainDeps["terminalRefs"];
  isWindowOwned: (ref: WorkspacePaneContentRef) => boolean;
  isHandoffActive: (ref: WorkspacePaneContentRef) => boolean;
  titleOf: (ref: WorkspacePaneContentRef) => string;
  removeSlot: PtyContentDomainDeps["removeSlot"];
}

/** The domain table of every registered content kind, in close order (file before pty). */
export function createWorkspaceDomains(
  deps: WorkspaceDomainDeps,
): WorkspaceDomainTable {
  return createWorkspaceDomainTable({
    file: createFileContentDomain({
      store: deps.store,
      fileDomain: deps.fileDomain,
      isWindowOwned: deps.isWindowOwned,
      isHandoffActive: deps.isHandoffActive,
    }),
    pty: createPtyContentDomain({
      store: deps.store,
      terminalRefs: deps.terminalRefs,
      isWindowOwned: deps.isWindowOwned,
      titleOf: deps.titleOf,
      removeSlot: deps.removeSlot,
    }),
  });
}

import type {
  WorkspaceLayoutDocument,
  WorkspacePaneContentRef,
} from "../../lib/tauri";
import {
  listWorkspacePanes,
  type WorkspaceNode,
} from "../../lib/ptyWorkspaceLayout";
import { workspaceContentKey } from "../../lib/workspaceContentKey";
import type { WorkspaceContentCoordinator } from "../../lib/workspaceContentCoordinator";
import type { WorkspaceFileBuffer } from "../../lib/workspaceFileBuffer";
import { validateWorkspaceLayoutDocument } from "../../lib/workspaceLayoutPersistence";

export interface InvariantContext {
  tree: WorkspaceNode;
  slots: ReadonlyArray<{ instanceId: string }>;
  fileDocuments: ReadonlyArray<{ id: string }>;
  fileBuffers: Record<string, Pick<WorkspaceFileBuffer, "saving">>;
  detachedFileIds: ReadonlySet<string>;
  detachedInstanceIds: ReadonlySet<string>;
}

export interface InvariantHost {
  errors: unknown[];
  backend: { saved: Array<{ layout: WorkspaceLayoutDocument }> };
  coordinator?: WorkspaceContentCoordinator;
  ctx: () => InvariantContext;
}

export interface InvariantOptions {
  allowPendingSaves?: boolean;
}

function managed(content: WorkspacePaneContentRef) {
  return content.kind === "unknown" ? [] : [content];
}

/**
 * 依次检查 I1~I7。违规时抛 Error(`workspace invariant I<n> violated: ...`)。
 * 没有注入 coordinator 时跳过 I4 与 I7，并在抛出的消息里注明“未注入 coordinator”；
 * I5 在没有 coordinator 时以 ctx.detachedFileIds 与 ctx.detachedInstanceIds 作为窗口拥有集合。
 */
export function assertWorkspaceInvariants(
  host: InvariantHost,
  options: InvariantOptions = {},
): { skipped: string[] } {
  const coordinator = host.coordinator;
  const skipped = coordinator ? [] : ["I4", "I7"];
  const note = coordinator ? "" : " [I4、I7 已跳过：未注入 coordinator]";
  const fail = (id: string, detail: string): never => {
    throw new Error(`workspace invariant ${id} violated: ${detail}${note}`);
  };
  const context = host.ctx();

  // I1：渲染期没有捕获到任何错误
  if (host.errors.length > 0) {
    fail(
      "I1",
      `host.errors has ${host.errors.length} entries, first: ${String(host.errors[0])}`,
    );
  }

  // I2：每个已保存的布局都通过校验
  host.backend.saved.forEach((saved, index) => {
    try {
      validateWorkspaceLayoutDocument(saved.layout);
    } catch (error) {
      fail("I2", `saved layout #${index} is invalid: ${String(error)}`);
    }
  });

  // I3：树中每个非 unknown 内容最多出现一次
  const panes = listWorkspacePanes(context.tree);
  const treeKeys = new Map<string, string>();
  for (const pane of panes) {
    for (const content of pane.contents.flatMap(managed)) {
      const key = workspaceContentKey(content);
      if (treeKeys.has(key)) {
        fail(
          "I3",
          `${key} appears in panes ${treeKeys.get(key)} and ${pane.id}`,
        );
      }
      treeKeys.set(key, pane.id);
    }
  }

  // I4：树与 coordinator 一致（需要注入）
  if (coordinator) {
    for (const pane of panes) {
      for (const content of pane.contents.flatMap(managed)) {
        const state = coordinator.get(content);
        const key = workspaceContentKey(content);
        if (!state) {
          fail(
            "I4",
            `${key} is in pane ${pane.id} but has no coordinator state`,
          );
        } else if (state.phase === "attached") {
          if (state.owner.paneId !== pane.id) {
            fail(
              "I4",
              `${key} is attached to pane ${state.owner.paneId} but sits in pane ${pane.id}`,
            );
          }
        } else if (state.phase === "detaching") {
          if (state.source.paneId !== pane.id) {
            fail(
              "I4",
              `${key} is detaching from pane ${state.source.paneId} but sits in pane ${pane.id}`,
            );
          }
        } else if (state.phase === "closing") {
          if (state.owner.kind !== "pane") {
            fail(
              "I4",
              `${key} is closing under a window owner but still sits in pane ${pane.id}`,
            );
          }
        } else {
          fail(
            "I4",
            `${key} is in pane ${pane.id} while its coordinator phase is ${state.phase}`,
          );
        }
      }
    }
    for (const content of coordinator.listInPhases("detached", "returning")) {
      const key = workspaceContentKey(content);
      if (treeKeys.has(key)) {
        fail(
          "I4",
          `${key} is detached or returning in the coordinator but still in the tree`,
        );
      }
    }
  }

  // I5：每个 slot、每个 document 要么在树中，要么由窗口拥有
  const windowOwnedKeys = new Set<string>();
  if (coordinator) {
    coordinator
      .listWindowOwned()
      .forEach((content) => windowOwnedKeys.add(workspaceContentKey(content)));
  } else {
    context.detachedFileIds.forEach((documentId) =>
      windowOwnedKeys.add(workspaceContentKey({ kind: "file", documentId })),
    );
    context.detachedInstanceIds.forEach((slotId) =>
      windowOwnedKeys.add(workspaceContentKey({ kind: "pty", slotId })),
    );
  }
  for (const slot of context.slots) {
    const key = workspaceContentKey({ kind: "pty", slotId: slot.instanceId });
    if (!treeKeys.has(key) && !windowOwnedKeys.has(key)) {
      fail("I5", `${key} is neither in the tree nor window-owned`);
    }
  }
  for (const document of context.fileDocuments) {
    const key = workspaceContentKey({ kind: "file", documentId: document.id });
    if (!treeKeys.has(key) && !windowOwnedKeys.has(key)) {
      fail("I5", `${key} is neither in the tree nor window-owned`);
    }
  }

  // I6：没有进行中的保存（除非显式允许）
  if (!options.allowPendingSaves) {
    for (const [documentId, buffer] of Object.entries(context.fileBuffers)) {
      if (buffer.saving)
        fail("I6", `file buffer ${documentId} is still saving`);
    }
  }

  // I7：宿主的分离集合等于 coordinator 的窗口拥有集合（需要注入）
  if (coordinator) {
    const ownedFiles = new Set<string>();
    const ownedSlots = new Set<string>();
    for (const content of coordinator.listWindowOwned()) {
      if (content.kind === "file") ownedFiles.add(content.documentId);
      if (content.kind === "pty") ownedSlots.add(content.slotId);
    }
    const sameSet = (left: ReadonlySet<string>, right: ReadonlySet<string>) =>
      left.size === right.size && [...left].every((value) => right.has(value));
    if (!sameSet(context.detachedFileIds, ownedFiles)) {
      fail(
        "I7",
        `detachedFileIds [${[...context.detachedFileIds]}] differs from coordinator [${[...ownedFiles]}]`,
      );
    }
    if (!sameSet(context.detachedInstanceIds, ownedSlots)) {
      fail(
        "I7",
        `detachedInstanceIds [${[...context.detachedInstanceIds]}] differs from coordinator [${[...ownedSlots]}]`,
      );
    }
  }

  return { skipped };
}

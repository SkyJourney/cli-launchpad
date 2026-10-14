import type {
  Directory,
  WorkspaceLayoutDocument,
  WorkspacePaneContentRef,
} from "../../lib/tauri";
import {
  listWorkspacePanes,
  listWorkspacePaneContents,
  remapWorkspaceFileIds,
  type WorkspaceNode,
} from "../../lib/ptyWorkspaceLayout";
import { reduceWorkspaceTree } from "../../lib/workspaceContentCommand";
import {
  createWorkspaceLayoutDocument,
  listPersistedDetachedContents,
  restoreCurrentWorkspaceFilesAfterPreset,
  restoreWorkspaceLayoutApplyPlan,
} from "../../lib/workspaceLayoutPersistence";
import type { HostSnapshot } from "../host/workspaceHostStore";

import { toWorkspaceLayoutSlot } from "./workspaceLayoutSlot";

/** 当前布局（排除受保护的分离内容）：只读计算，不做任何副作用。 */
export function currentPresetLayoutFrom(args: {
  live: HostSnapshot;
  protectedContents: WorkspacePaneContentRef[];
  directories: Directory[];
}): WorkspaceLayoutDocument {
  const { live } = args;
  let presetTree = live.tree;
  for (const content of args.protectedContents) {
    presetTree = reduceWorkspaceTree(presetTree, {
      type: "detach",
      ref: content,
    });
  }
  const presetPanes = listWorkspacePanes(presetTree);
  const paneSlotIds = new Set(
    presetPanes.flatMap((pane) =>
      listWorkspacePaneContents(pane, "pty").flatMap((content) =>
        content.kind === "pty" ? [content.slotId] : [],
      ),
    ),
  );
  const paneFileIds = new Set(
    presetPanes.flatMap((pane) =>
      listWorkspacePaneContents(pane, "file").flatMap((content) =>
        content.kind === "file" ? [content.documentId] : [],
      ),
    ),
  );
  const currentFocusedPaneId = live.focusedPaneId;
  return createWorkspaceLayoutDocument({
    tree: presetTree,
    focusedPaneId: presetPanes.some((pane) => pane.id === currentFocusedPaneId)
      ? currentFocusedPaneId
      : presetPanes[0].id,
    slots: live.slots
      .filter((slot) => paneSlotIds.has(slot.instanceId))
      .map((slot) => toWorkspaceLayoutSlot(slot, args.directories)),
    documents: live.documents.filter((document) =>
      paneFileIds.has(document.id),
    ),
    detachedContents: [],
  });
}

/** 应用预设前提交给服务端的布局：分离中的内容先并回树，再写入布局。只读计算。 */
export function activePresetLayoutFrom(args: {
  live: HostSnapshot;
  detachedContents: WorkspacePaneContentRef[];
  protectedContents: WorkspacePaneContentRef[];
  directories: Directory[];
}): WorkspaceLayoutDocument {
  const { live } = args;
  let activeTree: WorkspaceNode = live.tree;
  for (const content of args.detachedContents) {
    activeTree = reduceWorkspaceTree(activeTree, {
      type: "detach",
      ref: content,
    });
  }
  const activePanes = listWorkspacePanes(activeTree);
  return createWorkspaceLayoutDocument({
    tree: activeTree,
    focusedPaneId: activePanes.some((pane) => pane.id === live.focusedPaneId)
      ? live.focusedPaneId
      : activePanes[0].id,
    slots: live.slots.map((slot) =>
      toWorkspaceLayoutSlot(slot, args.directories),
    ),
    documents: live.documents,
    detachedContents: listPersistedDetachedContents(
      args.protectedContents,
      activeTree,
    ),
  });
}

/**
 * 预设计划之后的纯计算：把计划还原为树与文档。
 * 副作用（失效加载、登记归属、释放文档、发布状态）全部由调用方在它之后按原顺序执行。
 */
export function restorePresetPlan(args: {
  restored: ReturnType<typeof restoreWorkspaceLayoutApplyPlan>;
  currentDocuments: HostSnapshot["documents"];
  detachedNow: WorkspacePaneContentRef[];
  detachingNow: WorkspacePaneContentRef[];
}) {
  const { restored } = args;
  const restoredSlots = restored.slots;
  const restoredDocuments = [...(restored.documents ?? [])];
  const currentDocumentByIdentity = new Map(
    args.currentDocuments.map((document) => [
      `${document.directoryId}:${document.relativePath}`,
      document,
    ]),
  );
  const documentIdMap = new Map<string, string>();
  const normalizedDocuments = restoredDocuments.map((document) => {
    const currentDocument = currentDocumentByIdentity.get(
      `${document.directoryId}:${document.relativePath}`,
    );
    if (!currentDocument) return document;
    documentIdMap.set(document.id, currentDocument.id);
    return currentDocument;
  });
  let restoredTree = remapWorkspaceFileIds(restored.tree, documentIdMap);
  restoredDocuments.splice(0, restoredDocuments.length, ...normalizedDocuments);
  const restoredFiles = restoreCurrentWorkspaceFilesAfterPreset({
    tree: restoredTree,
    focusedPaneId: restored.focusedPaneId,
    restoredDocuments,
    currentDocuments: args.currentDocuments,
    detachedContents: restored.detachedContents,
    currentlyDetachedContents: args.detachedNow,
    detachingContents: args.detachingNow,
  });
  restoredTree = restoredFiles.tree;
  return {
    restoredSlots,
    restoredTree,
    focusedPaneId: restored.focusedPaneId,
    nextDocuments: restoredFiles.documents,
  };
}

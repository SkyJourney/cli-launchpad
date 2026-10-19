import { getAppErrorCode } from "./appErrors";
import {
  documentIdentityKey,
  UNKNOWN_PATH_SEMANTICS,
  type PathSemantics,
} from "./pathKey";
import {
  listWorkspacePanes,
  placeContentExclusively,
  removeWorkspaceContentFromTree,
  removeWorkspaceSession,
  sameWorkspaceContent,
  type WorkspaceNode,
} from "./ptyWorkspaceLayout";
import {
  type WorkspaceLayoutApplyPlan,
  type WorkspaceLayoutDocument,
  type WorkspaceLayoutNode,
  type WorkspaceLayoutSaveResult,
  type WorkspaceLayoutSlot,
  type WorkspacePaneContentRef,
  type WorkspaceFileDocument,
  type WorkspaceSlotState,
  type WorkspaceSlotStateKind,
} from "./tauri";
import { abortableDelay } from "./abortableDelay";
import { exponentialDelay } from "./retryPolicy";
import { workspaceContentKey } from "./workspaceContentKey";

export const WORKSPACE_LAYOUT_SCHEMA_VERSION = 5;
export { listPersistedDetachedContents } from "./workspaceOwnershipProjection";

export type WorkspaceLayoutSaveErrorCode =
  | "layout.save_rejected"
  | "layout.schema_incompatible";

export class WorkspaceLayoutSaveError extends Error {
  constructor(
    readonly code: WorkspaceLayoutSaveErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceLayoutSaveError";
  }
}

export class UnsupportedWorkspaceLayoutVersionError extends Error {
  readonly code = "layout.needs_reset";

  constructor(version: unknown) {
    super(`Unsupported workspace layout version: ${String(version)}`);
    this.name = "UnsupportedWorkspaceLayoutVersionError";
  }
}

const MAX_ABNORMAL_SAVE_REJECTIONS = 3;

export interface WorkspaceRuntimeSnapshot {
  tree: WorkspaceNode;
  focusedPaneId: string;
  slots: WorkspaceLayoutSlot[];
  documents?: WorkspaceFileDocument[];
  detachedContents: WorkspacePaneContentRef[];
}

export interface RestoredWorkspaceSnapshot extends WorkspaceRuntimeSnapshot {
  slots: RestoredWorkspaceSlot[];
}

export type RestoredWorkspaceSlot = WorkspaceLayoutSlot & {
  restoredState: WorkspaceSlotStateKind;
};

export interface WorkspaceLayoutApplySnapshot extends WorkspaceRuntimeSnapshot {
  slots: (WorkspaceLayoutSlot & {
    restoredState?: WorkspaceSlotStateKind;
  })[];
}

export interface WorkspaceApplyStateVersion {
  tree: WorkspaceNode;
  slots: readonly unknown[];
  focusedPaneId: string;
  detachedContents: readonly WorkspacePaneContentRef[];
}

export function isWorkspaceApplyStateCurrent(
  expected: WorkspaceApplyStateVersion,
  current: WorkspaceApplyStateVersion,
): boolean {
  return (
    expected.tree === current.tree &&
    expected.slots === current.slots &&
    expected.focusedPaneId === current.focusedPaneId &&
    sameWorkspaceContentRefs(
      expected.detachedContents,
      current.detachedContents,
    )
  );
}

export function markWorkspaceSlotsRestored(
  slots: WorkspaceLayoutSlot[],
  slotStates: WorkspaceSlotState[],
): RestoredWorkspaceSlot[] {
  const statesById = new Map(
    slotStates.map((slotState) => [slotState.instanceId, slotState]),
  );

  return slots.map((slot) => {
    const state = statesById.get(slot.instanceId);
    const restoredState = state?.state;
    return {
      ...cloneWorkspaceSlot(slot),
      projectName: state?.currentProjectName ?? slot.projectName,
      restoredState:
        restoredState === "missingProject" ||
        restoredState === "projectIdentityMismatch" ||
        restoredState === "missingSession" ||
        restoredState === "sessionIdentityMismatch"
          ? restoredState
          : "ended",
    };
  });
}

export function removeEndedWorkspaceSlots(
  snapshot: RestoredWorkspaceSnapshot,
): RestoredWorkspaceSnapshot {
  const endedSlotIds = snapshot.slots
    .filter((slot) => slot.restoredState === "ended")
    .map((slot) => slot.instanceId);
  if (endedSlotIds.length === 0) return snapshot;

  let tree = snapshot.tree;
  for (const instanceId of endedSlotIds) {
    tree = removeWorkspaceSession(tree, instanceId);
  }

  return {
    ...snapshot,
    tree,
    slots: snapshot.slots.filter((slot) => slot.restoredState !== "ended"),
    detachedContents: snapshot.detachedContents.filter(
      (content) =>
        content.kind !== "pty" || !endedSlotIds.includes(content.slotId),
    ),
  };
}

export function createWorkspaceLayoutDocument(
  snapshot: WorkspaceRuntimeSnapshot,
): WorkspaceLayoutDocument {
  const document: WorkspaceLayoutDocument = {
    schemaVersion: WORKSPACE_LAYOUT_SCHEMA_VERSION,
    tree: cloneWorkspaceNode(snapshot.tree),
    focusedPaneId: snapshot.focusedPaneId,
    slots: snapshot.slots.map(cloneWorkspaceSlot),
    documents: (snapshot.documents ?? []).map((document) => ({ ...document })),
    detachedContents: snapshot.detachedContents.map((content) => ({
      ...content,
    })),
  };
  validateWorkspaceLayoutDocument(document);
  return document;
}

export function restoreWorkspaceRuntimeSnapshot(
  sourceDocument: WorkspaceLayoutDocument,
): WorkspaceRuntimeSnapshot {
  const document = migrateWorkspaceLayoutDocument(sourceDocument);
  return {
    tree: cloneWorkspaceNode(document.tree),
    focusedPaneId: document.focusedPaneId,
    slots: document.slots.map(cloneWorkspaceSlot),
    documents: (document.documents ?? []).map((file) => ({ ...file })),
    detachedContents: document.detachedContents.map((content) => ({
      ...content,
    })),
  };
}

export function restoreWorkspaceLayoutApplyPlan(
  plan: WorkspaceLayoutApplyPlan,
): WorkspaceLayoutApplySnapshot {
  const snapshot = restoreWorkspaceRuntimeSnapshot(plan.layout);
  const detachedPtySlotIds = new Set(
    snapshot.detachedContents.flatMap((content) =>
      content.kind === "pty" ? [content.slotId] : [],
    ),
  );
  const statesById = new Map(
    plan.slotStates.map((slotState) => [slotState.instanceId, slotState]),
  );
  const endedIds = new Set<string>();
  const slots = snapshot.slots.flatMap((slot) => {
    const state = statesById.get(slot.instanceId);
    if (!state || state.state === "ended") {
      endedIds.add(slot.instanceId);
      return [];
    }

    const invalidState =
      state.state === "missingProject" ||
      state.state === "projectIdentityMismatch" ||
      state.state === "missingSession" ||
      state.state === "sessionIdentityMismatch";

    return [
      {
        ...cloneWorkspaceSlot(slot),
        projectName: state.currentProjectName ?? slot.projectName,
        ...(invalidState ? { restoredState: state.state } : {}),
      },
    ];
  });

  let tree = snapshot.tree;
  for (const instanceId of detachedPtySlotIds) {
    tree = removeWorkspaceSession(tree, instanceId);
  }
  for (const instanceId of endedIds) {
    tree = removeWorkspaceSession(tree, instanceId);
  }

  return {
    ...snapshot,
    tree,
    focusedPaneId: listWorkspacePanes(tree).some(
      (pane) => pane.id === snapshot.focusedPaneId,
    )
      ? snapshot.focusedPaneId
      : listWorkspacePanes(tree)[0].id,
    slots,
    detachedContents: snapshot.detachedContents.filter(
      (content) => content.kind !== "pty" || !endedIds.has(content.slotId),
    ),
  };
}

export function restoreCurrentWorkspaceFilesAfterPreset(input: {
  tree: WorkspaceNode;
  focusedPaneId: string;
  restoredDocuments: WorkspaceFileDocument[];
  currentDocuments: WorkspaceFileDocument[];
  detachedContents: WorkspacePaneContentRef[];
  currentlyDetachedContents: WorkspacePaneContentRef[];
  detachingContents: WorkspacePaneContentRef[];
  /** Path semantics per project; omitted means `unknown` (exact paths only). */
  semanticsOf?: (directoryId: number) => PathSemantics;
  /**
   * Current documents that must keep their own identity even when a restored document
   * differs from them only by case: unsaved edits, or owned by another window.
   */
  protectedDocumentIds?: ReadonlySet<string>;
}): {
  tree: WorkspaceNode;
  documents: WorkspaceFileDocument[];
  detachedContents: WorkspacePaneContentRef[];
} {
  let tree = input.tree;
  const semanticsOf = input.semanticsOf ?? (() => UNKNOWN_PATH_SEMANTICS);
  const literalKey = (document: WorkspaceFileDocument) =>
    documentIdentityKey(
      document.directoryId,
      document.relativePath,
      UNKNOWN_PATH_SEMANTICS,
    );
  const foldedKey = (document: WorkspaceFileDocument) =>
    documentIdentityKey(
      document.directoryId,
      document.relativePath,
      semanticsOf(document.directoryId),
    );
  const documents = [...input.restoredDocuments];
  const restoredPaths = new Set(documents.map(literalKey));
  const restoredByFoldedKey = new Map(
    documents.map((document) => [foldedKey(document), document]),
  );
  const currentDocumentByIdentity = new Map(
    input.currentDocuments.map((document) => [literalKey(document), document]),
  );
  const currentlyDetached = input.currentlyDetachedContents;
  const firstPaneId = listWorkspacePanes(tree)[0].id;
  const owns = (
    contents: readonly WorkspacePaneContentRef[],
    document: WorkspaceFileDocument,
  ) =>
    contents.some((candidate) =>
      sameWorkspaceContent(candidate, {
        kind: "file",
        documentId: document.id,
      }),
    );

  for (const document of input.currentDocuments) {
    const identity = literalKey(document);
    // A current document that only differs from a restored one by case folding gives way to
    // it, unless it has edits or belongs to another window.
    const keepsItsOwn =
      input.protectedDocumentIds?.has(document.id) === true ||
      owns(currentlyDetached, document) ||
      owns(input.detachingContents, document);
    const restoredByFolding =
      !restoredPaths.has(identity) && !keepsItsOwn
        ? restoredByFoldedKey.get(foldedKey(document))
        : undefined;
    const alreadyRestored =
      restoredPaths.has(identity) || restoredByFolding !== undefined;
    const canonicalDocument =
      restoredByFolding ?? currentDocumentByIdentity.get(identity) ?? document;
    if (!alreadyRestored) documents.push({ ...canonicalDocument });
    restoredPaths.add(identity);
    const content: WorkspacePaneContentRef = {
      kind: "file",
      documentId: canonicalDocument.id,
    };
    if (
      currentlyDetached.some((candidate) =>
        sameWorkspaceContent(candidate, content),
      )
    ) {
      tree = removeWorkspaceContentFromTree(tree, content);
    } else if (
      input.detachingContents.some((candidate) =>
        sameWorkspaceContent(candidate, content),
      )
    ) {
      tree = placeContentExclusively(tree, input.focusedPaneId, content);
    } else if (!alreadyRestored) {
      tree = placeContentExclusively(tree, firstPaneId, content);
    }
  }

  const detachedContents = [...input.detachedContents];
  for (const content of input.currentlyDetachedContents) {
    if (
      !detachedContents.some((candidate) =>
        sameWorkspaceContent(candidate, content),
      )
    ) {
      detachedContents.push({ ...content });
    }
  }
  for (const content of detachedContents) {
    if (content.kind === "file") {
      tree = removeWorkspaceContentFromTree(tree, content);
    }
  }
  for (const content of detachedContents) {
    if (content.kind !== "file") continue;
    const document =
      input.currentDocuments.find(
        (candidate) => candidate.id === content.documentId,
      ) ?? documents.find((candidate) => candidate.id === content.documentId);
    if (
      document &&
      !documents.some(
        (candidate) =>
          candidate.directoryId === document.directoryId &&
          candidate.relativePath === document.relativePath,
      )
    ) {
      documents.push({ ...document });
    }
  }

  return { tree, documents, detachedContents };
}

export function rehomeDetachedWorkspaceContents(
  snapshot: WorkspaceRuntimeSnapshot,
): WorkspaceRuntimeSnapshot {
  if (snapshot.detachedContents.length === 0) return snapshot;

  let tree = snapshot.tree;
  const firstPaneId = listWorkspacePanes(tree)[0].id;
  const focusedPaneId = listWorkspacePanes(tree).some(
    (pane) => pane.id === snapshot.focusedPaneId,
  )
    ? snapshot.focusedPaneId
    : firstPaneId;
  for (const content of snapshot.detachedContents) {
    tree = placeContentExclusively(
      tree,
      content.kind === "file" ? focusedPaneId : firstPaneId,
      content,
    );
  }

  return {
    ...snapshot,
    tree,
    focusedPaneId,
    detachedContents: [],
  };
}

export function cloneWorkspaceLayoutDocument(
  document: WorkspaceLayoutDocument,
): WorkspaceLayoutDocument {
  return {
    schemaVersion: document.schemaVersion,
    tree: cloneWorkspaceNode(document.tree),
    focusedPaneId: document.focusedPaneId,
    slots: document.slots.map(cloneWorkspaceSlot),
    documents: (document.documents ?? []).map((file) => ({ ...file })),
    detachedContents: document.detachedContents.map((content) => ({
      ...content,
    })),
  };
}

function cloneWorkspaceSlot(slot: WorkspaceLayoutSlot): WorkspaceLayoutSlot {
  return {
    ...slot,
    title: { ...slot.title },
  };
}

function cloneWorkspaceNode(node: WorkspaceNode): WorkspaceLayoutNode {
  if (node.kind === "pane") {
    return {
      kind: "pane",
      id: node.id,
      paneNumber: node.paneNumber,
      contents: node.contents.map((content) => ({ ...content })),
      activeContent: node.activeContent ? { ...node.activeContent } : null,
    };
  }

  return {
    kind: "split",
    id: node.id,
    direction: node.direction,
    ratio: node.ratio,
    first: cloneWorkspaceNode(node.first),
    second: cloneWorkspaceNode(node.second),
  };
}

function sameWorkspaceContentRefs(
  left: readonly WorkspacePaneContentRef[],
  right: readonly WorkspacePaneContentRef[],
): boolean {
  return (
    left.length === right.length &&
    left.every((content, index) => {
      const other = right[index];
      return workspaceContentKey(content) === workspaceContentKey(other);
    })
  );
}

// Validates only: layout migration from older versions lives in Rust (PD-16).
export function migrateWorkspaceLayoutDocument(
  source: unknown,
): WorkspaceLayoutDocument {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("Workspace layout must be an object");
  }
  const value = { ...(source as Record<string, unknown>) };
  if (value.schemaVersion !== WORKSPACE_LAYOUT_SCHEMA_VERSION) {
    throw new UnsupportedWorkspaceLayoutVersionError(value.schemaVersion);
  }
  if (value.detachedContents === undefined) value.detachedContents = [];
  const document = value as unknown as WorkspaceLayoutDocument;
  validateWorkspaceLayoutDocument(document);
  return document;
}

export function validateWorkspaceLayoutDocument(
  document: WorkspaceLayoutDocument,
): void {
  if (document.schemaVersion !== WORKSPACE_LAYOUT_SCHEMA_VERSION) {
    throw new Error("Workspace layout version is invalid");
  }
  const slotIds = new Set(document.slots.map((slot) => slot.instanceId));
  const documentIds = new Set(document.documents.map((file) => file.id));
  if (!Array.isArray(document.detachedContents)) {
    throw new Error("Detached workspace contents are invalid");
  }
  if (
    slotIds.size !== document.slots.length ||
    documentIds.size !== document.documents.length
  ) {
    throw new Error("Workspace layout identities must be unique");
  }
  const referencedSlots = new Set<string>();
  const referencedDocuments = new Set<string>();
  const paneIds = new Set<string>();
  const visit = (node: WorkspaceLayoutDocument["tree"]): void => {
    if (node.kind === "split") {
      visit(node.first);
      visit(node.second);
      return;
    }
    paneIds.add(node.id);
    for (const content of node.contents) {
      if (content.kind === "unknown") continue;
      if (content.kind === "pty") {
        if (
          !slotIds.has(content.slotId) ||
          referencedSlots.has(content.slotId)
        ) {
          throw new Error("PTY content has missing or duplicate ownership");
        }
        referencedSlots.add(content.slotId);
      } else {
        if (
          !documentIds.has(content.documentId) ||
          referencedDocuments.has(content.documentId)
        ) {
          throw new Error("File content has missing or duplicate ownership");
        }
        referencedDocuments.add(content.documentId);
      }
    }
  };
  visit(document.tree);
  for (const content of document.detachedContents) {
    if (content.kind === "unknown") continue;
    if (content.kind === "pty") {
      if (!slotIds.has(content.slotId) || referencedSlots.has(content.slotId)) {
        throw new Error(
          "Detached PTY content has missing or duplicate ownership",
        );
      }
      referencedSlots.add(content.slotId);
    } else {
      if (
        !documentIds.has(content.documentId) ||
        referencedDocuments.has(content.documentId)
      ) {
        throw new Error(
          "Detached file content has missing or duplicate ownership",
        );
      }
      referencedDocuments.add(content.documentId);
    }
  }
  if (
    !paneIds.has(document.focusedPaneId) ||
    referencedSlots.size !== slotIds.size ||
    referencedDocuments.size !== documentIds.size
  ) {
    throw new Error("Workspace layout contains unowned content or focus");
  }
}

export interface WorkspaceLayoutSaveQueueOptions {
  /** 异常拒绝之后、重新发送之前的等待；测试注入立即返回的实现。 */
  delay?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  /**
   * 后端因“仅大小写不同的重复文档”拒绝保存（layout.case_duplicate）时的修复入口：
   * `merge` 合并变体并返回新的待保存布局（队列只重试一次）；`degrade` 丢弃后出现的变体，
   * 不再发送——降级后的状态在下一次正常保存时落库。
   */
  repairCaseDuplicate?: (
    error: unknown,
    mode: "merge" | "degrade",
  ) => Promise<{ changed: boolean; document: WorkspaceLayoutDocument | null }>;
}

/** 第 1 次异常拒绝后等 250 ms，第 2 次等 500 ms（第 3 次直接停止，不等待）。 */
const ABNORMAL_REJECTION_BACKOFF = exponentialDelay({
  baseMs: 250,
  capMs: 4000,
});

export class WorkspaceLayoutSaveQueue {
  private revision: number;
  private pending: WorkspaceLayoutDocument | null = null;
  private draining: Promise<void> | null = null;
  private abnormalRejections = 0;
  private caseDuplicateRejections = 0;
  private readonly repairCaseDuplicate: WorkspaceLayoutSaveQueueOptions["repairCaseDuplicate"];
  private readonly abort = new AbortController();
  private readonly delay: (
    delayMs: number,
    signal: AbortSignal,
  ) => Promise<void>;

  constructor(
    initialRevision: number,
    private readonly save: (
      revision: number,
      layout: WorkspaceLayoutDocument,
    ) => Promise<WorkspaceLayoutSaveResult>,
    private readonly onError: (error: unknown) => void,
    private readonly onSaved: () => void = () => undefined,
    options: WorkspaceLayoutSaveQueueOptions = {},
  ) {
    this.revision = Math.max(0, initialRevision);
    this.delay = options.delay ?? abortableDelay;
    this.repairCaseDuplicate = options.repairCaseDuplicate;
  }

  /** 中止正在进行的退避等待；之后的退避立即返回，异常拒绝仍受 3 次上限约束。 */
  dispose(): void {
    this.abort.abort();
  }

  enqueue(document: WorkspaceLayoutDocument): void {
    this.pending = cloneWorkspaceLayoutDocument(document);
    this.startDrain();
  }

  async flush(): Promise<void> {
    while (this.draining || this.pending) {
      if (!this.draining) this.startDrain();
      const currentDrain = this.draining;
      if (currentDrain) await currentDrain;
    }
  }

  private startDrain(): void {
    if (this.draining || !this.pending) return;

    const drain = this.drainQueue();
    this.draining = drain.finally(() => {
      this.draining = null;
      if (this.pending) this.startDrain();
    });
  }

  private async drainQueue(): Promise<void> {
    while (this.pending) {
      const document = this.pending;
      this.pending = null;
      const revision = this.revision + 1;
      this.revision = revision;

      try {
        const result = await this.save(
          revision,
          cloneWorkspaceLayoutDocument(document),
        );
        this.revision = Math.max(this.revision, result.revision);
        if (result.saved) {
          this.abnormalRejections = 0;
          this.caseDuplicateRejections = 0;
          try {
            this.onSaved();
          } catch {
            // A UI status callback must not interfere with the save queue.
          }
        } else if (result.reason === "incompatible") {
          // 存储的布局版本高于当前应用支持：重试没有意义，只上报一次。
          this.abnormalRejections = 0;
          this.report(
            new WorkspaceLayoutSaveError(
              "layout.schema_incompatible",
              "当前工作区布局由更高版本的应用写入，当前版本无法保存",
            ),
          );
        } else if (result.revision >= revision) {
          // 真实落后：以后端返回的 revision 为基准重试。
          this.abnormalRejections = 0;
          if (!this.pending) this.pending = document;
        } else {
          // 后端说它的 revision 比我们发送的还小却拒绝了（N16 的症状）：限次重试。
          this.abnormalRejections += 1;
          if (this.abnormalRejections >= MAX_ABNORMAL_SAVE_REJECTIONS) {
            this.abnormalRejections = 0;
            this.report(
              new WorkspaceLayoutSaveError(
                "layout.save_rejected",
                "工作区布局保存被后端连续拒绝，已停止重试",
              ),
            );
          } else {
            if (!this.pending) this.pending = document;
            await this.delay(
              ABNORMAL_REJECTION_BACKOFF(this.abnormalRejections - 1),
              this.abort.signal,
            );
          }
        }
      } catch (error) {
        if (await this.handleCaseDuplicate(error)) continue;
        this.report(error);
      }
    }
  }

  /**
   * layout.case_duplicate: the first rejection merges the variants and retries once; a second
   * rejection (or nothing to merge) drops the later variants and stops. At most two saves are
   * sent, no timer is involved, and the degraded state is stored by the next regular save.
   * Returns whether the error was handled (otherwise it is reported as any other error).
   */
  private async handleCaseDuplicate(error: unknown): Promise<boolean> {
    const repair = this.repairCaseDuplicate;
    if (!repair || getAppErrorCode(error) !== "layout.case_duplicate") {
      // Any other outcome ends a case-duplicate sequence.
      this.caseDuplicateRejections = 0;
      return false;
    }
    this.caseDuplicateRejections += 1;
    if (this.caseDuplicateRejections === 1) {
      const merged = await repair(error, "merge").catch(() => null);
      if (merged?.changed && merged.document) {
        // Built from the live state after the merge: newer than anything queued before it.
        this.pending = merged.document;
        return true;
      }
    }
    this.caseDuplicateRejections = 0;
    const degraded = await repair(error, "degrade").catch(() => null);
    return degraded?.changed === true;
  }

  private report(error: unknown): void {
    try {
      this.onError(error);
    } catch {
      // Error reporting must not stop workspace interaction or later saves.
    }
  }
}

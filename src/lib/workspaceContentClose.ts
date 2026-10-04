import type { WorkspaceContentCoordinator } from "./workspaceContentCoordinator";
import type { WorkspacePaneContentRef } from "./tauri";
import type { WorkspaceContentOwner } from "./workspaceContentLifecycle";

export interface WorkspaceContentBeforeCloseContext {
  isDirty: boolean;
  confirmDiscard: () => boolean;
}

export interface WorkspaceContentDisposeContext<
  Kind extends WorkspacePaneContentRef["kind"] =
    WorkspacePaneContentRef["kind"],
> {
  content: Extract<WorkspacePaneContentRef, { kind: Kind }>;
  owner: WorkspaceContentOwner;
  generation: number;
  requestId?: string;
  reason: "closed" | "ownerEnded";
}

/** Completes the host lifecycle transition before notifying the adapter once. */
export async function disposeWorkspaceContent<
  Kind extends WorkspacePaneContentRef["kind"],
>(args: {
  coordinator: WorkspaceContentCoordinator;
  content: Extract<WorkspacePaneContentRef, { kind: Kind }>;
  reason: WorkspaceContentDisposeContext<Kind>["reason"];
  requestId?: string;
  dispose?: (
    context: WorkspaceContentDisposeContext<Kind>,
  ) => void | Promise<void>;
}): Promise<boolean> {
  const { coordinator, content, reason, requestId, dispose } = args;
  const state = coordinator.get(content);
  if (!state || state.phase === "disposed") return false;
  const owner =
    state.phase === "closing"
      ? state.owner
      : state.phase === "detached"
        ? state.owner
        : state.phase === "attached"
          ? state.owner
          : state.phase === "detaching" || state.phase === "returning"
            ? state.source
            : null;
  if (!owner) return false;

  const transition =
    reason === "closed" && requestId
      ? coordinator.completeDispose(content, requestId)
      : reason === "ownerEnded"
        ? coordinator.ownerEnded(content)
        : null;
  if (
    transition?.outcome !== "changed" ||
    transition.state.phase !== "disposed"
  ) {
    return false;
  }

  try {
    await dispose?.({
      content,
      owner,
      generation: state.generation,
      requestId,
      reason,
    });
  } catch (error) {
    // Disposal is a post-commit notification. A plugin failure must not
    // resurrect already-closed content or interfere with its owner cleanup.
    console.error("Workspace content adapter dispose hook failed", error);
  }
  return true;
}

export async function closeWorkspaceContentBatch(args: {
  coordinator: WorkspaceContentCoordinator;
  requestId: string;
  requests: Array<{
    content: WorkspacePaneContentRef;
    beforeClose: () => boolean;
  }>;
  /** Performs domain-specific state changes and returns only committed closes. */
  execute: () => WorkspacePaneContentRef[] | Promise<WorkspacePaneContentRef[]>;
  dispose: (context: WorkspaceContentDisposeContext) => void | Promise<void>;
}): Promise<WorkspacePaneContentRef[]> {
  const unique = [
    ...new Map(
      args.requests.map((request) => [contentKey(request.content), request]),
    ).values(),
  ];
  if (
    unique.length === 0 ||
    unique.some((request) => {
      try {
        return !request.beforeClose();
      } catch {
        return true;
      }
    })
  ) {
    return [];
  }
  if (
    !args.coordinator.approveCloseBatch(
      unique.map(({ content }) => content),
      args.requestId,
    )
  ) {
    return [];
  }

  let committed: WorkspacePaneContentRef[];
  try {
    committed = await args.execute();
  } catch (error) {
    for (const { content } of unique) {
      args.coordinator.cancelClose(content, args.requestId);
    }
    throw error;
  }
  const committedKeys = new Set(committed.map(contentKey));
  for (const { content } of unique) {
    if (!committedKeys.has(contentKey(content))) {
      args.coordinator.cancelClose(content, args.requestId);
      continue;
    }
    await disposeWorkspaceContent({
      coordinator: args.coordinator,
      content,
      requestId: args.requestId,
      reason: "closed",
      dispose: args.dispose as (
        context: WorkspaceContentDisposeContext<any>,
      ) => void | Promise<void>,
    });
  }
  return committed;
}

function contentKey(content: WorkspacePaneContentRef): string {
  return content.kind === "pty"
    ? `pty:${content.slotId}`
    : `file:${content.documentId}`;
}

export type WorkspaceContentBeforeCloseHook = (
  context: WorkspaceContentBeforeCloseContext,
) => boolean;

export type WorkspaceContentWindowBeforeCloseHook = () => boolean;

export interface WorkspaceContentCloseRequest {
  hook: WorkspaceContentBeforeCloseHook | undefined;
  context: WorkspaceContentBeforeCloseContext;
}

export function shouldCloseWorkspaceContent(
  hook: WorkspaceContentBeforeCloseHook | undefined,
  context: WorkspaceContentBeforeCloseContext,
): boolean {
  if (!hook) return true;
  try {
    return hook(context);
  } catch {
    return false;
  }
}

export function canCloseWorkspaceContents(
  requests: WorkspaceContentCloseRequest[],
): boolean {
  return requests.every(({ hook, context }) =>
    shouldCloseWorkspaceContent(hook, context),
  );
}

export function requestWorkspaceContentClose(
  hook: WorkspaceContentBeforeCloseHook | undefined,
  context: WorkspaceContentBeforeCloseContext,
  close: () => void,
): boolean {
  if (!shouldCloseWorkspaceContent(hook, context)) return false;
  close();
  return true;
}

export function shouldCloseWorkspaceWindow(
  hook: WorkspaceContentWindowBeforeCloseHook | undefined,
): boolean {
  if (!hook) return true;
  try {
    return hook();
  } catch {
    return false;
  }
}

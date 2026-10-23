import type { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { WorkspaceContentHandoffHookContext } from "../../components/workspaceContentAdapterRegistry";
import type { RegisteredContentKind } from "../../generated/contentKinds";
import type { WorkspaceContentHandoffPayloadByKind } from "../../lib/workspaceContentLifecycle";
import type { ManagedContentRef } from "../../lib/workspaceContentKey";
import { advancePendingWindowStage, type PendingWindowStage } from "../../lib/workspaceContentPendingStage";
import {
  promotePendingWorkspaceContentWindow,
  takePendingWorkspaceContentWindow,
  type WorkspaceContentWindowRecord,
} from "../../lib/workspaceContentWindowRegistry";
import type { ContentWindowOrchestrator } from "./contentWindowOrchestrator";
import { prepareWorkspaceContentHandoff } from "../../components/workspaceContentHandoffRuntime";
import { rollbackHandoffOnce } from "./handoffRollback";
import {
  findWorkspacePane,
  hasWorkspaceContent,
  listWorkspacePanes,
} from "../../lib/ptyWorkspaceLayout";
import { MAIN_WINDOW_LABEL } from "../../lib/windowKinds";

/** The fields the shared handshake reads from a pending record of any content kind. */
export interface PendingHandshakeRecord<K extends RegisteredContentKind>
  extends WorkspaceContentWindowRecord {
  kind: K;
  stage: PendingWindowStage;
  windowLabel: string;
  transferId: string;
  windowToken: string;
  window: WebviewWindow;
  handoffContext?: WorkspaceContentHandoffHookContext<K>;
  handoffPayload?: WorkspaceContentHandoffPayloadByKind[K];
  resolve: () => void;
  reject: (reason: Error) => void;
}

export interface PendingHandshakeMaps<
  K extends RegisteredContentKind,
  P extends PendingHandshakeRecord<K>,
  D,
> {
  pending: Map<string, P>;
  detached: Map<string, D>;
  key: string;
  /** The content reference of this record, in the form the coordinator and host expect. */
  ref: Extract<ManagedContentRef, { kind: K }>;
  toDetached: (record: P) => D;
}

/**
 * Accepts the child window's attach acknowledgement: the handshake shared by PTY `ready` and file
 * `attached`. The caller has already matched the event's identity to the pending record.
 */
export function acceptPendingAttach<
  K extends RegisteredContentKind,
  P extends PendingHandshakeRecord<K>,
  D,
>(
  orchestrator: ContentWindowOrchestrator,
  pending: P,
  maps: PendingHandshakeMaps<K, P, D>,
): void {
  const { deps } = orchestrator;
  if (!advancePendingWindowStage(pending, "attachedAck")) return;
  const outcome = deps.execute({
    type: "completeDetach",
    ref: maps.ref,
    token: pending.transferId,
    windowToken: pending.windowToken,
  });
  if (outcome.status === "ignored") {
    if (pending.handoffContext) {
      void rollbackHandoffOnce(
        pending.handoffContext,
        pending.handoffPayload,
        new Error(deps.translate("pty.detachedStateChanged")),
      ).catch(() => undefined);
    }
    takePendingWorkspaceContentWindow(
      maps.pending,
      maps.key,
      pending.windowLabel,
    );
    pending.reject(new Error(deps.translate("pty.detachedStateChanged")));
    void pending.window.destroy().catch(() => undefined);
    return;
  }
  promotePendingWorkspaceContentWindow({
    pending: maps.pending,
    detached: maps.detached,
    key: maps.key,
    expectedWindowLabel: pending.windowLabel,
    toDetached: maps.toDetached,
  });
  pending.resolve();
}

/**
 * Fails a pending handoff reported by the child window: rolls the handoff back, marks the coordinator
 * entry as failed, and rejects the pending promise. `message` is the caller's user-facing text.
 */
export function failPendingHandoff<
  K extends RegisteredContentKind,
  P extends PendingHandshakeRecord<K>,
>(
  orchestrator: ContentWindowOrchestrator,
  pending: P,
  args: {
    pendingMap: Map<string, P>;
    key: string;
    ref: Extract<ManagedContentRef, { kind: K }>;
    message: string;
  },
): void {
  const { deps } = orchestrator;
  if (pending.handoffContext) {
    void rollbackHandoffOnce(
      pending.handoffContext,
      pending.handoffPayload,
      new Error(args.message),
    ).catch(() => undefined);
  }
  deps
    .getCoordinator()
    .failHandoff(args.ref, "detachFailed", pending.transferId);
  takePendingWorkspaceContentWindow(
    args.pendingMap,
    args.key,
    pending.windowLabel,
  );
  pending.reject(new Error(args.message));
  void pending.window.destroy().catch(() => undefined);
}

/**
 * Accepts a child window's `ready` for a content whose window needs an init payload. The handoff is
 * prepared through the content's adapter and then the init message is sent; a failure at either
 * step rolls the handoff back and rejects the pending promise. The caller has matched the identity.
 */
export async function acceptWindowReady<
  K extends RegisteredContentKind,
  P extends PendingHandshakeRecord<K>,
>(
  orchestrator: ContentWindowOrchestrator,
  args: {
    pending: P;
    pendingMap: Map<string, P>;
    key: string;
    ref: Extract<ManagedContentRef, { kind: K }>;
    lateReadyMessage: string;
    driverContext: WorkspaceContentHandoffHookContext<K>;
    emitInit: (payload: WorkspaceContentHandoffPayloadByKind[K]) => Promise<void>;
    reasonText: (reason: unknown) => string;
  },
): Promise<void> {
  const { deps } = orchestrator;
  const { pending, driverContext } = args;
  if (!advancePendingWindowStage(pending, "windowReady")) {
    console.warn(args.lateReadyMessage);
    return;
  }
  const abandon = (
    payload: WorkspaceContentHandoffPayloadByKind[K] | undefined,
    reason: unknown,
  ) => {
    void rollbackHandoffOnce(driverContext, payload, reason).catch(() => undefined);
    deps.getCoordinator().failHandoff(args.ref, "detachFailed", pending.transferId);
    takePendingWorkspaceContentWindow(args.pendingMap, args.key, pending.windowLabel);
    pending.reject(new Error(args.reasonText(reason)));
    void pending.window.destroy().catch(() => undefined);
  };
  let payload: WorkspaceContentHandoffPayloadByKind[K];
  try {
    payload = (await prepareWorkspaceContentHandoff(driverContext)).payload;
  } catch (reason) {
    abandon(undefined, reason);
    return;
  }
  pending.handoffContext = driverContext;
  pending.handoffPayload = payload;
  if (!advancePendingWindowStage(pending, "initSent")) return;
  try {
    await args.emitInit(payload);
  } catch (reason) {
    // init 没有送达：立即回滚并结束等待，不再依赖超时兜底。
    abandon(payload, reason);
  }
}

/**
 * Reconciles a content that is not detached back into the ownership of the window that returns it:
 * the source pane is the pane holding the content, else the focused pane, else the first pane. The
 * caller decides whether reconciliation applies; `windowToken` is read only once a pane is found, so
 * the order of id generation is unchanged.
 */
export function reconcileFromSourcePane(
  orchestrator: ContentWindowOrchestrator,
  args: { content: ManagedContentRef; windowLabel: string; windowToken: () => string },
): void {
  const { deps } = orchestrator;
  const tree = deps.store.getLive().tree;
  const sourcePane =
    listWorkspacePanes(tree).find((pane) => hasWorkspaceContent(pane, args.content)) ??
    findWorkspacePane(tree, deps.store.getLive().focusedPaneId) ??
    listWorkspacePanes(tree)[0];
  if (!sourcePane) return;
  deps.getCoordinator().reconcileDetached(
    args.content,
    { kind: "pane", windowLabel: MAIN_WINDOW_LABEL, paneId: sourcePane.id },
    { kind: "window", windowLabel: args.windowLabel },
    deps.getCoordinator().newTransferId(),
    args.windowToken(),
  );
}

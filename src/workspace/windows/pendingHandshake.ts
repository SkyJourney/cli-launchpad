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
import { rollbackHandoffOnce } from "./handoffRollback";

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

import type { IsolatedRegistration } from "../../lib/retryPolicy";
import { setupWorkspaceContentListeners } from "../../lib/workspaceContentListenerSetup";
import type {
  ContentWindowOrchestrator,
  DetachedWindowReadyEvent,
  ProtocolListenerShell,
  PtyReturnRequestEvent,
  PtySessionOwnerLostEvent,
} from "./contentWindowOrchestrator";

import { toast } from "sonner";

import { abortableDelay } from "../../lib/abortableDelay";
import { RUST_EVENTS } from "../../lib/eventNames";
import { windowKindOf } from "../../lib/windowKinds";
import { onInboxEvent } from "../../lib/windowInbox";
import { onContentHandoff } from "../../lib/workspaceContentWindowProtocol";
import {
  findWorkspacePane,
  listWorkspacePanes,
  hasWorkspaceContent,
} from "../../lib/ptyWorkspaceLayout";
import { matchesDetachedWindow } from "../../lib/ptySessionLifecycle";

import { retryWithBackoff } from "../../lib/retryPolicy";
import {
  PTY_OWNER_LOST_MAX_ATTEMPTS,
  ptyOwnerLostRetryDelay,
  type PtyOwnerLostAttemptResult,
} from "../../lib/ptyOwnerLostRecovery";
import {
  promotePendingWorkspaceContentWindow,
  takePendingWorkspaceContentWindow,
} from "../../lib/workspaceContentWindowRegistry";
import { advancePendingWindowStage } from "../../lib/workspaceContentPendingStage";
import { ownerWindowOf } from "../../lib/workspaceOwnershipProjection";
import { formatAppError } from "../../lib/appErrors";

import { ptyContentKey, ptyContentRef } from "../../lib/workspaceContentKey";

import { type WorkspaceContentHandoffPayloadByKind } from "../../lib/workspaceContentLifecycle";

import {
  planWorkspaceReturn,
  reduceWorkspaceTree,
  resolveWorkspaceReturnPaneId,
} from "../../lib/workspaceContentCommand";
import {
  attachWorkspaceContentHandoff,
  rollbackWorkspaceContentHandoff,
} from "../../components/workspaceContentHandoffRuntime";
import type { WorkspaceContentHandoffHookContext } from "../../components/workspaceContentAdapterRegistry";

export interface PtyProtocolHandlers {
  /** 与宿主原 PTY 监听列表逐项对应（名称与顺序一致）。 */
  registrations(): IsolatedRegistration[];
}

export function createPtyProtocolHandlers(
  orchestrator: ContentWindowOrchestrator,
): PtyProtocolHandlers {
  const { state, deps, ports } = orchestrator;
  const ownerLostRecoveries = new Set<string>();

  const handleDetachedReady = (payload: DetachedWindowReadyEvent) => {
    const pending = state.pending.pty.get(ptyContentKey(payload.instanceId));
    if (!pending || !matchesDetachedWindow(pending, payload)) {
      return;
    }
    if (!advancePendingWindowStage(pending, "attachedAck")) return;
    const ownership = deps
      .getCoordinator()
      .completeHandoff(
        ptyContentRef(payload.instanceId),
        "detachReady",
        pending.token,
      );
    if (ownership?.outcome !== "changed") {
      void rollbackWorkspaceContentHandoff(
        pending.handoffContext,
        pending.handoffPayload,
        new Error(deps.translate("pty.detachedStateChanged")),
      ).catch(() => undefined);
      takePendingWorkspaceContentWindow(
        state.pending.pty,
        ptyContentKey(payload.instanceId),
        pending.windowLabel,
      );
      pending.reject(new Error(deps.translate("pty.detachedStateChanged")));
      void pending.window.destroy().catch(() => undefined);
      return;
    }
    promotePendingWorkspaceContentWindow({
      pending: state.pending.pty,
      detached: state.handles.pty,
      key: ptyContentKey(payload.instanceId),
      expectedWindowLabel: pending.windowLabel,
      toDetached: (record) => record.window,
    });
    const content = ptyContentRef(payload.instanceId);
    const nextTree = reduceWorkspaceTree(deps.store.getLive().tree, {
      type: "detach",
      ref: content,
    });
    deps.commitTree(nextTree);
    if (!findWorkspacePane(nextTree, deps.store.getLive().focusedPaneId)) {
      deps.setFocusedPane(listWorkspacePanes(nextTree)[0].id);
    }
    pending.resolve();
  };
  const handleDetachedFailed = (
    payload: DetachedWindowReadyEvent & { message?: string },
  ) => {
    const pending = state.pending.pty.get(ptyContentKey(payload.instanceId));
    if (!pending || !matchesDetachedWindow(pending, payload)) return;
    void rollbackWorkspaceContentHandoff(
      pending.handoffContext,
      pending.handoffPayload,
      new Error(payload.message || deps.translate("pty.detachedStartFailed")),
    ).catch(() => undefined);
    deps
      .getCoordinator()
      .failHandoff(
        ptyContentRef(payload.instanceId),
        "detachFailed",
        pending.token,
      );
    takePendingWorkspaceContentWindow(
      state.pending.pty,
      ptyContentKey(payload.instanceId),
      pending.windowLabel,
    );
    pending.reject(
      new Error(payload.message || deps.translate("pty.detachedStartFailed")),
    );
    void pending.window.destroy().catch(() => undefined);
  };
  const handlePtySessionOwnerLost = async ({
    sessionId,
  }: PtySessionOwnerLostEvent) => {
    if (ownerLostRecoveries.has(sessionId)) {
      console.warn(
        `PTY owner-lost recovery already running for session ${sessionId}; ignoring duplicate event.`,
      );
      return;
    }
    ownerLostRecoveries.add(sessionId);
    const signal = state.lifecycleAbort.current.signal;
    try {
      const outcome = await retryWithBackoff<PtyOwnerLostAttemptResult>(
        async () => {
          const slot = deps.store
            .getLive()
            .slots.find((candidate) => candidate.sessionId === sessionId);
          if (!slot) return { kind: "slot-gone" };
          const terminal = deps.terminalOf(slot.instanceId);
          if (!terminal || deps.store.getLive().hydrationStatus !== "ready") {
            throw new Error(
              "PTY terminal is not ready for owner-lost recovery",
            );
          }
          try {
            await terminal.reattachLostSession(sessionId);
            return { kind: "reattached" };
          } catch (reason) {
            const status = await ports
              .getPtySessionWindowStatus(sessionId)
              .catch(() => null);
            if (status?.state === "ended") {
              const pending = takePendingWorkspaceContentWindow(
                state.pending.pty,
                ptyContentKey(slot.instanceId),
              );
              pending?.reject(
                new Error(deps.translate("pty.detachedStartFailed")),
              );
              deps.removeSlot(slot.instanceId);
              return { kind: "ended" };
            }
            if (status?.state === "ownedByAnotherWindow") {
              return { kind: "foreign-owner" };
            }
            console.warn(
              `Failed to reclaim PTY session ${sessionId}; will retry:`,
              reason,
            );
            throw reason;
          }
        },
        {
          maxAttempts: PTY_OWNER_LOST_MAX_ATTEMPTS,
          delayMs: ptyOwnerLostRetryDelay,
          signal,
          onExhausted: (lastError, attempts) => {
            console.error(
              `PTY owner-lost recovery gave up for session ${sessionId} after ${attempts} attempts`,
              lastError,
            );
            toast.error(deps.translate("pty.ownerLostRecoveryFailed"));
          },
        },
      );
      if (
        signal.aborted ||
        outcome.status !== "succeeded" ||
        outcome.value.kind !== "reattached"
      ) {
        return;
      }

      const slot = deps.store
        .getLive()
        .slots.find((candidate) => candidate.sessionId === sessionId);
      if (!slot) return;
      const content = ptyContentRef(slot.instanceId);
      const currentTree = deps.store.getLive().tree;
      const existingPane = listWorkspacePanes(currentTree).find((pane) =>
        hasWorkspaceContent(pane, content),
      );
      const targetPane =
        existingPane ??
        findWorkspacePane(currentTree, deps.store.getLive().focusedPaneId) ??
        listWorkspacePanes(currentTree)[0];
      if (!targetPane) return;
      const pending = takePendingWorkspaceContentWindow(
        state.pending.pty,
        ptyContentKey(slot.instanceId),
      );
      pending?.reject(new Error(deps.translate("pty.detachedStartTimedOut")));
      const detached = state.handles.pty.get(ptyContentKey(slot.instanceId));
      state.handles.pty.delete(ptyContentKey(slot.instanceId));
      if (detached) void detached.destroy().catch(() => undefined);
      deps.getCoordinator().ownerEnded(content);
      deps.getCoordinator().ensureAttached(content, {
        kind: "pane",
        windowLabel: "main",
        paneId: targetPane.id,
      });
      const nextTree = reduceWorkspaceTree(
        currentTree,
        existingPane
          ? { type: "activate", ref: content, paneId: existingPane.id }
          : { type: "return", ref: content, toPaneId: targetPane.id },
      );
      deps.commitTree(nextTree);
      deps.setFocusedPane(existingPane?.id ?? targetPane.id);
      deps.openDirectory(slot.directoryId);
    } finally {
      ownerLostRecoveries.delete(sessionId);
    }
  };
  const handlePtyReturnRequest = async (payload: PtyReturnRequestEvent) => {
    const fail = (message: string) =>
      void ports
        .emit(payload.windowLabel, "pty", "return-failed", {
          instanceId: payload.instanceId,
          token: payload.token,
          message,
        })
        .catch(() => undefined);
    const returningContent = ptyContentRef(payload.instanceId);
    const key = ptyContentKey(payload.instanceId);
    // 返回完成之后到达的重复请求：静默忽略，不得走 reconcileDetached。
    if (deps.getCoordinator().isReturnCompleted(payload.token)) {
      return;
    }
    const currentOwnership = deps.getCoordinator().get(returningContent);
    const knownWindowLabel =
      ownerWindowOf(currentOwnership)?.windowLabel ?? null;
    if (knownWindowLabel && knownWindowLabel !== payload.windowLabel) {
      fail(deps.translate("pty.detachedSessionMissing"));
      return;
    }
    if (!knownWindowLabel && windowKindOf(payload.windowLabel) !== "terminal") {
      fail(deps.translate("pty.detachedSessionMissing"));
      return;
    }
    let detachedWindow = state.handles.pty.get(key);
    if (!detachedWindow || !knownWindowLabel) {
      try {
        const [windowStatus, detachedWindow] = await Promise.all([
          ports.getPtySessionWindowStatus(payload.sessionId),
          ports.getWindowByLabel(payload.windowLabel),
        ]);
        if (windowStatus.state !== "ownedByAnotherWindow" || !detachedWindow) {
          fail(deps.translate("pty.detachedStateChanged"));
          return;
        }
        state.handles.pty.set(key, detachedWindow);
      } catch (reason) {
        fail(
          deps.translate("pty.returnFailed", {
            error: formatAppError(reason, deps.translate),
          }),
        );
        return;
      }
    }
    detachedWindow ??= state.handles.pty.get(key);
    if (!detachedWindow) {
      fail(deps.translate("pty.detachedStateChanged"));
      return;
    }
    if (
      currentOwnership?.phase === "returning" &&
      currentOwnership.transferId === payload.token
    ) {
      return;
    }
    if (currentOwnership?.phase !== "detached") {
      const sourcePane =
        listWorkspacePanes(deps.store.getLive().tree).find((pane) =>
          hasWorkspaceContent(pane, returningContent),
        ) ??
        findWorkspacePane(
          deps.store.getLive().tree,
          deps.store.getLive().focusedPaneId,
        ) ??
        listWorkspacePanes(deps.store.getLive().tree)[0];
      if (sourcePane) {
        deps.getCoordinator().reconcileDetached(
          returningContent,
          {
            kind: "pane",
            windowLabel: "main",
            paneId: sourcePane.id,
          },
          { kind: "window", windowLabel: payload.windowLabel },
          payload.token,
        );
      }
    }
    const returnTargetPaneId = resolveWorkspaceReturnPaneId(
      deps.store.getLive().tree,
      {
        requestedPaneId: payload.targetPaneId,
        lastPaneId: (() => {
          const latest = deps.getCoordinator().get(returningContent);
          return latest?.phase === "detached" ? latest.lastPaneId : null;
        })(),
        focusedPaneId: deps.store.getLive().focusedPaneId,
      },
    );
    if (!returnTargetPaneId) {
      fail(deps.translate("pty.workspaceRestoring"));
      return;
    }
    const returning = deps
      .getCoordinator()
      .beginReturn(returningContent, payload.token, "main", returnTargetPaneId);
    if (returning?.outcome !== "changed") {
      fail(deps.translate("pty.detachedStateChanged"));
      return;
    }
    const failPendingReturn = (message: string) => {
      deps
        .getCoordinator()
        .failHandoff(returningContent, "returnFailed", payload.token);
      fail(message);
    };
    let returnDriverContext: WorkspaceContentHandoffHookContext<"pty"> | null =
      null;
    let returnDriverPayload:
      | WorkspaceContentHandoffPayloadByKind["pty"]
      | undefined;
    try {
      state.returnWaitAbort.current?.abort();
      const waitAbortController = new AbortController();
      state.returnWaitAbort.current = waitAbortController;
      const deadline = Date.now() + 10_000;
      let slot = deps.store
        .getLive()
        .slots.find((candidate) => candidate.instanceId === payload.instanceId);
      let terminal = deps.terminalOf(payload.instanceId);
      while (
        (!slot ||
          !terminal ||
          deps.store.getLive().hydrationStatus !== "ready") &&
        Date.now() < deadline &&
        !waitAbortController.signal.aborted
      ) {
        await abortableDelay(50, waitAbortController.signal);
        if (waitAbortController.signal.aborted) return;
        slot = deps.store
          .getLive()
          .slots.find(
            (candidate) => candidate.instanceId === payload.instanceId,
          );
        terminal = deps.terminalOf(payload.instanceId);
      }
      if (state.returnWaitAbort.current === waitAbortController) {
        state.returnWaitAbort.current = null;
      }
      if (waitAbortController.signal.aborted) return;
      if (
        !slot ||
        !terminal ||
        deps.store.getLive().hydrationStatus !== "ready"
      ) {
        failPendingReturn(deps.translate("pty.workspaceRestoring"));
        return;
      }
      if (slot.sessionId !== payload.sessionId) {
        failPendingReturn(deps.translate("pty.detachedSessionMissing"));
        return;
      }
      const currentTree = deps.store.getLive().tree;
      // 与 beginReturn 时记录的目标 pane 一致，驱动上下文不再重新解析。
      const targetPane = findWorkspacePane(currentTree, returnTargetPaneId);
      if (!targetPane) {
        failPendingReturn(deps.translate("pty.workspaceRestoring"));
        return;
      }
      returnDriverContext = {
        content: returningContent,
        source: { kind: "window", windowLabel: payload.windowLabel },
        target: { kind: "pane", windowLabel: "main", paneId: targetPane.id },
        transferId: payload.token,
        capabilities: {
          prepare: async () => ({ handoff: { token: payload.token } }),
          attach: async (handoffPayload) => {
            await terminal.attachHandoff(
              payload.sessionId,
              handoffPayload.handoff.token,
            );
          },
          rollback: async (handoffPayload) => {
            if (handoffPayload) {
              await terminal.cancelHandoff(handoffPayload.handoff.token);
            }
          },
        },
      };
      returnDriverPayload = { handoff: { token: payload.token } };
      await attachWorkspaceContentHandoff(
        returnDriverContext,
        returnDriverPayload,
      );
      const activeReturn = deps.getCoordinator().get(returningContent);
      if (
        activeReturn?.phase !== "returning" ||
        activeReturn.transferId !== payload.token
      ) {
        throw new Error(deps.translate("pty.detachedStateChanged"));
      }
      // 在最新树上计算；从这里到 commitTree 之间不得出现 await。
      // 目标 pane 以 beginReturn 时协调器记录的为准（returnReady 把 owner 设为它）。
      const recordedPaneId = activeReturn.target.paneId;
      const plan = planWorkspaceReturn(deps.store.getLive().tree, {
        ref: returningContent,
        requestedPaneId: recordedPaneId,
        focusedPaneId: deps.store.getLive().focusedPaneId,
        whenAlreadyInTree: "activate",
      });
      if (!plan || plan.focusPaneId !== recordedPaneId) {
        throw new Error(deps.translate("pty.workspaceRestoring"));
      }
      // 先确认归属变更成立，再改树；被拒绝时抛出，由 catch 回滚终端交接并通知子窗口。
      const ownership = deps
        .getCoordinator()
        .completeHandoff(returningContent, "returnReady", payload.token);
      if (ownership?.outcome !== "changed") {
        throw new Error(deps.translate("pty.detachedStateChanged"));
      }
      deps.commitTree(plan.nextTree);
      deps.setFocusedPane(plan.focusPaneId);
      state.handles.pty.delete(ptyContentKey(payload.instanceId));
      deps.openDirectory(slot.directoryId);
      try {
        await detachedWindow.destroy();
      } catch (reason) {
        console.warn("Failed to destroy returned PTY window", reason);
        await ports
          .emit(payload.windowLabel, "pty", "return-complete", {
            instanceId: payload.instanceId,
            token: payload.token,
          })
          .catch(() => undefined);
      }
    } catch (reason) {
      if (returnDriverContext) {
        void rollbackWorkspaceContentHandoff(
          returnDriverContext,
          returnDriverPayload,
          reason,
        ).catch(() => undefined);
      }
      failPendingReturn(formatAppError(reason, deps.translate));
    }
  };

  return {
    registrations: () => [
      {
        name: "pty:ready",
        register: () =>
          onContentHandoff("pty", "ready", (event) =>
            handleDetachedReady(event.payload),
          ),
      },
      {
        name: "pty:failed",
        register: () =>
          onContentHandoff("pty", "failed", (event) =>
            handleDetachedFailed(event.payload),
          ),
      },
      {
        name: RUST_EVENTS.ptySessionOwnerLost,
        register: () =>
          onInboxEvent<PtySessionOwnerLostEvent>(
            RUST_EVENTS.ptySessionOwnerLost,
            (event) => {
              void handlePtySessionOwnerLost(event.payload);
            },
          ),
      },
      {
        name: "pty:return-requested",
        register: () =>
          onContentHandoff("pty", "return-requested", (event) => {
            void handlePtyReturnRequest(event.payload);
          }),
      },
      {
        name: "pty:exited",
        register: () =>
          onContentHandoff("pty", "exited", (event) => {
            const pending = state.pending.pty.get(
              ptyContentKey(event.payload.instanceId),
            );
            if (pending && matchesDetachedWindow(pending, event.payload)) {
              void rollbackWorkspaceContentHandoff(
                pending.handoffContext,
                pending.handoffPayload,
                new Error(deps.translate("pty.detachedExitedBeforeReady")),
              ).catch(() => undefined);
              deps
                .getCoordinator()
                .failHandoff(
                  ptyContentRef(event.payload.instanceId),
                  "detachCancelled",
                  pending.token,
                );
              takePendingWorkspaceContentWindow(
                state.pending.pty,
                ptyContentKey(event.payload.instanceId),
                pending.windowLabel,
              );
              pending.reject(
                new Error(deps.translate("pty.detachedExitedBeforeReady")),
              );
              void pending.window.destroy().catch(() => undefined);
              deps.removeSlot(event.payload.instanceId);
              return;
            }
            const content = ptyContentRef(event.payload.instanceId);
            const owner = deps.getCoordinator().get(content);
            const slot = deps.store
              .getLive()
              .slots.find(
                (candidate) =>
                  candidate.instanceId === event.payload.instanceId,
              );
            if (
              slot?.sessionId === event.payload.sessionId &&
              (((owner?.phase === "detached" || owner?.phase === "closing") &&
                owner.owner.kind === "window" &&
                owner.owner.windowLabel === event.payload.windowLabel) ||
                (owner?.phase === "returning" &&
                  owner.source.windowLabel === event.payload.windowLabel))
            ) {
              deps.removeSlot(event.payload.instanceId);
            }
          }),
      },
    ],
  };
}

export function startPtyListeners(
  handlers: PtyProtocolHandlers,
  shell: ProtocolListenerShell,
): () => void {
  const controller = new AbortController();
  let unlisten: () => void = () => undefined;
  void setupWorkspaceContentListeners({
    registrations: handlers.registrations(),
    signal: controller.signal,
    retryDelaysMs: shell.retryDelaysMs,
    onFailed: (failed) => shell.onFailed("PTY window", failed),
  }).then((cleanup) => {
    unlisten = cleanup;
  });
  return () => {
    controller.abort();
    unlisten();
  };
}

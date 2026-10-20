import type { IsolatedRegistration } from "../../lib/retryPolicy";
import { setupWorkspaceContentListeners } from "../../lib/workspaceContentListenerSetup";
import type {
  ContentWindowOrchestrator,
  ManagedFileWindow,
  ProtocolListenerShell,
} from "./contentWindowOrchestrator";

import { RUST_EVENTS } from "../../lib/eventNames";
import { windowKindOf } from "../../lib/windowKinds";
import { onInboxEvent } from "../../lib/windowInbox";
import { onContentHandoff } from "../../lib/workspaceContentWindowProtocol";
import {
  addWorkspaceFileToPane,
  findWorkspacePane,
  listWorkspacePanes,
  hasWorkspaceContent,
} from "../../lib/ptyWorkspaceLayout";

import { matchesWorkspaceFileWindow } from "../../lib/workspaceFileWindow";

import {
  promotePendingWorkspaceContentWindow,
  takePendingWorkspaceContentWindow,
} from "../../lib/workspaceContentWindowRegistry";
import { advancePendingWindowStage } from "../../lib/workspaceContentPendingStage";
import {
  isWorkspaceFileBufferNewer,
  workspaceFileDocumentIdentityMatches,
} from "../../lib/workspaceFileBuffer";
import { formatAppError } from "../../lib/appErrors";

import { fileContentKey, fileContentRef } from "../../lib/workspaceContentKey";
import { requestWorkspaceFileBufferFlush } from "../../lib/workspaceFileExitFlush";

import { type WorkspaceContentHandoffPayloadByKind } from "../../lib/workspaceContentLifecycle";

import {
  planWorkspaceReturn,
  reduceWorkspaceTree,
  resolveWorkspaceReturnPaneId,
} from "../../lib/workspaceContentCommand";
import {
  attachWorkspaceContentHandoff,
  prepareWorkspaceContentHandoff,
  rollbackWorkspaceContentHandoff,
} from "../../components/workspaceContentHandoffRuntime";
import type { WorkspaceContentHandoffHookContext } from "../../components/workspaceContentAdapterRegistry";

export interface WorkspaceContentWindowLostEvent {
  windowLabel: string;
}

export interface FileProtocolHandlers {
  /** 文件窗组 5 项，与宿主原 effect 的顺序一致。 */
  registrations(): IsolatedRegistration[];
  /** lost 组 1 项。 */
  lostRegistrations(): IsolatedRegistration[];
}

/** 退出前请求文件窗口刷新缓冲；500 ms 超时与合并语义由调用方保持不变。 */
export function requestFileWindowFlush(
  orchestrator: ContentWindowOrchestrator,
  managed: ManagedFileWindow,
): ReturnType<typeof requestWorkspaceFileBufferFlush> {
  return requestWorkspaceFileBufferFlush({
    target: {
      documentId: managed.documentId,
      token: managed.token,
      windowLabel: managed.windowLabel,
    },
    listen: (handler) =>
      onContentHandoff("file", "flush-complete", ({ payload }) =>
        handler(payload),
      ),
    emit: (requestId) =>
      orchestrator.ports.emit(managed.windowLabel, "file", "flush-requested", {
        documentId: managed.documentId,
        token: managed.token,
        windowLabel: managed.windowLabel,
        requestId,
      }),
  });
}

export function createFileProtocolHandlers(
  orchestrator: ContentWindowOrchestrator,
): FileProtocolHandlers {
  const { state, deps, ports } = orchestrator;

  const handleWorkspaceContentWindowLost = ({
    windowLabel,
  }: WorkspaceContentWindowLostEvent) => {
    const coordinator = deps.getCoordinator();
    const lost = coordinator.listWindowOwned().filter((content) => {
      if (content.kind !== "file") return false;
      const state = coordinator.get(content);
      return (
        state?.phase === "detached" &&
        state.owner.kind === "window" &&
        state.owner.windowLabel === windowLabel
      );
    });
    if (lost.length === 0) return;
    const targetPane =
      findWorkspacePane(
        deps.store.getLive().tree,
        deps.store.getLive().focusedPaneId,
      ) ?? listWorkspacePanes(deps.store.getLive().tree)[0];
    let nextTree = deps.store.getLive().tree;
    for (const content of lost) {
      if (content.kind !== "file") continue;
      coordinator.ownerEnded(content);
      state.handles.file.delete(fileContentKey(content.documentId));
      coordinator.ensureAttached(content, {
        kind: "pane",
        windowLabel: "main",
        paneId: targetPane.id,
      });
      nextTree = addWorkspaceFileToPane(
        nextTree,
        targetPane.id,
        content.documentId,
      );
    }
    deps.commitTree(nextTree);
  };

  return {
    registrations: () => [
      {
        name: "file:ready",
        register: () =>
          onContentHandoff("file", "ready", async (event) => {
            const pending = state.pending.file.get(
              fileContentKey(event.payload.documentId),
            );
            if (
              !pending ||
              !matchesWorkspaceFileWindow(pending, event.payload)
            ) {
              return;
            }
            if (!advancePendingWindowStage(pending, "windowReady")) {
              console.warn(
                `Ignoring duplicate or late file:ready for ${pending.documentId} (stage ${pending.stage}).`,
              );
              return;
            }
            const content = fileContentRef(pending.documentId);
            const driverContext: WorkspaceContentHandoffHookContext<"file"> = {
              content,
              source: {
                kind: "pane",
                windowLabel: "main",
                paneId:
                  pending.sourcePaneId ??
                  listWorkspacePanes(deps.store.getLive().tree)[0]?.id ??
                  "unknown-pane",
              },
              target: {
                kind: "window",
                windowLabel: pending.windowLabel,
              },
              transferId: pending.transferId,
              capabilities: {
                prepare: async () => {
                  const document = deps.store
                    .getLive()
                    .documents.find(
                      (candidate) => candidate.id === pending.documentId,
                    );
                  const buffer =
                    deps.store.getLive().buffers[pending.documentId];
                  if (!document || !buffer) {
                    throw new Error(
                      deps.translate("workspaceFiles.loadingFile"),
                    );
                  }
                  return { document, buffer };
                },
                attach: async () => undefined,
                rollback: async () => undefined,
              },
            };
            let prepared: Awaited<
              ReturnType<typeof prepareWorkspaceContentHandoff<"file">>
            >;
            try {
              prepared = await prepareWorkspaceContentHandoff(driverContext);
              pending.handoffContext = driverContext;
              pending.handoffPayload = prepared.payload;
            } catch (reason) {
              void rollbackWorkspaceContentHandoff(
                driverContext,
                undefined,
                reason,
              ).catch(() => undefined);
              deps
                .getCoordinator()
                .failHandoff(content, "detachFailed", pending.transferId);
              takePendingWorkspaceContentWindow(
                state.pending.file,
                fileContentKey(pending.documentId),
                pending.windowLabel,
              );
              pending.reject(new Error(formatAppError(reason, deps.translate)));
              void pending.window.destroy().catch(() => undefined);
              return;
            }
            if (!advancePendingWindowStage(pending, "initSent")) return;
            try {
              await ports.emit(pending.windowLabel, "file", "init", {
                documentId: pending.documentId,
                token: pending.token,
                windowLabel: pending.windowLabel,
                fileDocument: prepared.payload.document,
                fileBuffer: prepared.payload.buffer,
              });
            } catch (reason) {
              // init 没有送达：立即回滚并结束等待，不再依赖 15 秒超时兜底。
              void rollbackWorkspaceContentHandoff(
                driverContext,
                prepared.payload,
                reason,
              ).catch(() => undefined);
              deps
                .getCoordinator()
                .failHandoff(content, "detachFailed", pending.transferId);
              takePendingWorkspaceContentWindow(
                state.pending.file,
                fileContentKey(pending.documentId),
                pending.windowLabel,
              );
              pending.reject(new Error(formatAppError(reason, deps.translate)));
              void pending.window.destroy().catch(() => undefined);
            }
          }),
      },
      {
        name: "file:attached",
        register: () =>
          onContentHandoff("file", "attached", (event) => {
            const pending = state.pending.file.get(
              fileContentKey(event.payload.documentId),
            );
            if (
              !pending ||
              !matchesWorkspaceFileWindow(pending, event.payload)
            ) {
              return;
            }
            // 只有 init 已发出（阶段为 initSent）的 pending 才接受 attached。
            if (!advancePendingWindowStage(pending, "attachedAck")) {
              return;
            }
            const content = fileContentRef(pending.documentId);
            const ownership = deps
              .getCoordinator()
              .completeHandoff(
                content,
                "detachReady",
                pending.transferId,
                pending.token,
              );
            if (ownership?.outcome !== "changed") {
              if (pending.handoffContext) {
                void rollbackWorkspaceContentHandoff(
                  pending.handoffContext,
                  pending.handoffPayload,
                  new Error(deps.translate("pty.detachedStateChanged")),
                ).catch(() => undefined);
              }
              takePendingWorkspaceContentWindow(
                state.pending.file,
                fileContentKey(pending.documentId),
                pending.windowLabel,
              );
              pending.reject(
                new Error(deps.translate("pty.detachedStateChanged")),
              );
              void pending.window.destroy().catch(() => undefined);
              return;
            }
            promotePendingWorkspaceContentWindow({
              pending: state.pending.file,
              detached: state.handles.file,
              key: fileContentKey(pending.documentId),
              expectedWindowLabel: pending.windowLabel,
              toDetached: (record) => record.window,
            });
            deps.commitTree(
              reduceWorkspaceTree(deps.store.getLive().tree, {
                type: "detach",
                ref: content,
              }),
            );
            pending.resolve();
          }),
      },
      {
        name: "file:failed",
        register: () =>
          onContentHandoff("file", "failed", (event) => {
            const pending = state.pending.file.get(
              fileContentKey(event.payload.documentId),
            );
            if (
              !pending ||
              !matchesWorkspaceFileWindow(pending, event.payload)
            ) {
              return;
            }
            if (pending.handoffContext) {
              void rollbackWorkspaceContentHandoff(
                pending.handoffContext,
                pending.handoffPayload,
                new Error(
                  event.payload.message ??
                    deps.translate("pty.detachedStartFailed"),
                ),
              ).catch(() => undefined);
            }
            deps
              .getCoordinator()
              .failHandoff(
                fileContentRef(pending.documentId),
                "detachFailed",
                pending.transferId,
              );
            takePendingWorkspaceContentWindow(
              state.pending.file,
              fileContentKey(pending.documentId),
              pending.windowLabel,
            );
            pending.reject(
              new Error(
                event.payload.message ??
                  deps.translate("pty.detachedStartFailed"),
              ),
            );
            void pending.window.destroy().catch(() => undefined);
          }),
      },
      {
        name: "file:state-changed",
        register: () =>
          onContentHandoff("file", "state-changed", (event) => {
            const content = fileContentRef(event.payload.documentId);
            const owner = deps.getCoordinator().get(content);
            if (
              !event.payload.fileBuffer ||
              owner?.phase !== "detached" ||
              owner.owner.kind !== "window" ||
              owner.owner.windowLabel !== event.payload.windowLabel ||
              owner.windowToken !== event.payload.token
            ) {
              return;
            }
            const currentBuffer =
              deps.store.getLive().buffers[content.documentId];
            if (
              !isWorkspaceFileBufferNewer(
                event.payload.fileBuffer,
                currentBuffer,
              )
            ) {
              return;
            }
            deps.mergeFileBuffers(
              { [content.documentId]: event.payload.fileBuffer },
              "handlePtyReturn:buffers",
            );
          }),
      },
      {
        name: "file:return-requested",
        register: () =>
          onContentHandoff("file", "return-requested", async (event) => {
            const knownDocument = deps.store
              .getLive()
              .documents.find(
                (document) => document.id === event.payload.documentId,
              );
            const incomingDocument = event.payload.fileDocument;
            const incomingBuffer = event.payload.fileBuffer;
            if (
              !knownDocument ||
              !incomingBuffer ||
              !workspaceFileDocumentIdentityMatches(
                knownDocument,
                incomingDocument,
              )
            ) {
              await ports
                .emit(event.payload.windowLabel, "file", "return-failed", {
                  documentId: event.payload.documentId,
                  token: event.payload.token,
                  message: deps.translate("pty.returnFailed", {
                    error: deps.translate("pty.workspaceRestoring"),
                  }),
                })
                .catch(() => undefined);
              return;
            }
            // 返回完成之后到达的重复请求：静默忽略，不得走 reconcileDetached。
            if (
              deps.getCoordinator().isWindowReturnCompleted(event.payload.token)
            ) {
              return;
            }
            const content = fileContentRef(event.payload.documentId);
            const key = fileContentKey(content.documentId);
            let managedWindow = state.handles.file.get(key);
            if (!managedWindow) {
              try {
                managedWindow =
                  (await ports.getWindowByLabel(event.payload.windowLabel)) ??
                  undefined;
              } catch {
                managedWindow = undefined;
              }
            }
            if (
              !managedWindow ||
              windowKindOf(event.payload.windowLabel) !== "workspaceContent"
            ) {
              await ports
                .emit(event.payload.windowLabel, "file", "return-failed", {
                  documentId: event.payload.documentId,
                  token: event.payload.token,
                  message: deps.translate("pty.returnFailed", {
                    error: deps.translate("pty.workspaceRestoring"),
                  }),
                })
                .catch(() => undefined);
              return;
            }
            // 本次返回的 transferId 由主窗口生成；子窗口只携带窗口令牌。
            const returnTransferId = deps.getCoordinator().newTransferId();
            let currentOwnership = deps.getCoordinator().get(content);
            if (
              currentOwnership?.phase === "returning" &&
              currentOwnership.windowToken === event.payload.token
            ) {
              return;
            }
            if (currentOwnership?.phase === "detached") {
              if (
                currentOwnership.owner.kind !== "window" ||
                currentOwnership.owner.windowLabel !==
                  event.payload.windowLabel ||
                currentOwnership.windowToken !== event.payload.token
              ) {
                await ports
                  .emit(event.payload.windowLabel, "file", "return-failed", {
                    documentId: event.payload.documentId,
                    token: event.payload.token,
                    message: deps.translate("pty.returnFailed", {
                      error: deps.translate("pty.detachedStateChanged"),
                    }),
                  })
                  .catch(() => undefined);
                return;
              }
            } else if (
              !currentOwnership ||
              currentOwnership.phase === "attached"
            ) {
              const sourcePane =
                listWorkspacePanes(deps.store.getLive().tree).find((pane) =>
                  hasWorkspaceContent(pane, content),
                ) ??
                findWorkspacePane(
                  deps.store.getLive().tree,
                  deps.store.getLive().focusedPaneId,
                ) ??
                listWorkspacePanes(deps.store.getLive().tree)[0];
              if (sourcePane) {
                deps.getCoordinator().reconcileDetached(
                  content,
                  {
                    kind: "pane",
                    windowLabel: "main",
                    paneId: sourcePane.id,
                  },
                  {
                    kind: "window",
                    windowLabel: event.payload.windowLabel,
                  },
                  deps.getCoordinator().newTransferId(),
                  event.payload.token,
                );
                currentOwnership = deps.getCoordinator().get(content);
              }
            }
            if (
              currentOwnership?.phase !== "detached" ||
              currentOwnership.owner.kind !== "window" ||
              currentOwnership.owner.windowLabel !==
                event.payload.windowLabel ||
              currentOwnership.windowToken !== event.payload.token
            ) {
              // 拒绝返回是显式结果：记录原因，并把拒绝告知子窗口；告知失败也要留下日志。
              console.warn(
                "workspace file return rejected: detached state changed",
                {
                  documentId: event.payload.documentId,
                  windowLabel: event.payload.windowLabel,
                },
              );
              await ports
                .emit(event.payload.windowLabel, "file", "return-failed", {
                  documentId: event.payload.documentId,
                  token: event.payload.token,
                  message: deps.translate("pty.returnFailed", {
                    error: deps.translate("pty.detachedStateChanged"),
                  }),
                })
                .catch((error: unknown) => {
                  console.warn(
                    "workspace file return-failed notification could not be delivered",
                    error,
                  );
                });
              return;
            }
            state.handles.file.set(key, managedWindow);
            const returnTargetPaneId = resolveWorkspaceReturnPaneId(
              deps.store.getLive().tree,
              {
                requestedPaneId: event.payload.targetPaneId,
                lastPaneId: (() => {
                  const latest = deps.getCoordinator().get(content);
                  return latest?.phase === "detached"
                    ? latest.lastPaneId
                    : null;
                })(),
                focusedPaneId: deps.store.getLive().focusedPaneId,
              },
            );
            if (!returnTargetPaneId) {
              await ports
                .emit(event.payload.windowLabel, "file", "return-failed", {
                  documentId: event.payload.documentId,
                  token: event.payload.token,
                  message: deps.translate("pty.returnFailed", {
                    error: deps.translate("pty.workspaceRestoring"),
                  }),
                })
                .catch(() => undefined);
              return;
            }
            const returning = deps
              .getCoordinator()
              .beginReturn(
                content,
                returnTransferId,
                "main",
                returnTargetPaneId,
              );
            if (returning?.outcome !== "changed") {
              await ports
                .emit(event.payload.windowLabel, "file", "return-failed", {
                  documentId: event.payload.documentId,
                  token: event.payload.token,
                  message: deps.translate("pty.returnFailed", {
                    error: deps.translate("pty.detachedStateChanged"),
                  }),
                })
                .catch(() => undefined);
              return;
            }
            let fileReturnDriverContext: WorkspaceContentHandoffHookContext<"file"> | null =
              null;
            let fileReturnDriverPayload:
              | WorkspaceContentHandoffPayloadByKind["file"]
              | undefined;
            try {
              const document = knownDocument;
              const currentBuffer = deps.store.getLive().buffers[document.id];
              const returnedBuffer =
                currentBuffer &&
                isWorkspaceFileBufferNewer(currentBuffer, incomingBuffer)
                  ? currentBuffer
                  : incomingBuffer;
              // 与 beginReturn 时记录的目标 pane 一致，驱动上下文不再重新解析。
              const targetPane = findWorkspacePane(
                deps.store.getLive().tree,
                returnTargetPaneId,
              );
              if (!targetPane)
                throw new Error(deps.translate("pty.workspaceRestoring"));
              fileReturnDriverContext = {
                content,
                source: {
                  kind: "window",
                  windowLabel: event.payload.windowLabel,
                },
                target: {
                  kind: "pane",
                  windowLabel: "main",
                  paneId: targetPane.id,
                },
                transferId: returnTransferId,
                capabilities: {
                  prepare: async () => ({
                    document,
                    buffer: returnedBuffer,
                  }),
                  attach: async (handoffPayload) => {
                    deps.mergeFileBuffers(
                      { [document.id]: handoffPayload.buffer },
                      "handlePtyReturn:buffers",
                    );
                  },
                  rollback: async () => undefined,
                },
              };
              fileReturnDriverPayload = {
                document,
                buffer: returnedBuffer,
              };
              await attachWorkspaceContentHandoff(
                fileReturnDriverContext,
                fileReturnDriverPayload,
              );
              const activeReturn = deps.getCoordinator().get(content);
              if (
                activeReturn?.phase !== "returning" ||
                activeReturn.transferId !== returnTransferId
              ) {
                throw new Error(deps.translate("pty.detachedStateChanged"));
              }
              // 在最新树上计算；从这里到 commitTree 之间不得出现 await。
              // 目标 pane 以 beginReturn 时协调器记录的为准（returnReady 把 owner 设为它）。
              const recordedPaneId = activeReturn.target.paneId;
              const plan = planWorkspaceReturn(deps.store.getLive().tree, {
                ref: content,
                requestedPaneId: recordedPaneId,
                focusedPaneId: deps.store.getLive().focusedPaneId,
                whenAlreadyInTree: "relocate",
              });
              if (!plan || plan.focusPaneId !== recordedPaneId) {
                throw new Error(deps.translate("pty.workspaceRestoring"));
              }
              // 先确认归属变更成立，再改树；被拒绝时树保持原样，子窗口仍可重试。
              const ownership = deps
                .getCoordinator()
                .completeHandoff(
                  fileContentRef(document.id),
                  "returnReady",
                  returnTransferId,
                );
              if (ownership?.outcome !== "changed") {
                deps
                  .getCoordinator()
                  .failHandoff(
                    fileContentRef(document.id),
                    "returnFailed",
                    returnTransferId,
                  );
                await ports
                  .emit(event.payload.windowLabel, "file", "return-failed", {
                    documentId: document.id,
                    token: event.payload.token,
                    message: deps.translate("pty.returnFailed", {
                      error: deps.translate("pty.detachedStateChanged"),
                    }),
                  })
                  .catch(() => undefined);
                return;
              }
              deps.commitTree(plan.nextTree);
              deps.setFocusedPane(plan.focusPaneId);
              state.handles.file.delete(fileContentKey(document.id));
              await ports
                .revokeFile(event.payload.windowLabel)
                .catch((reason) =>
                  console.warn(
                    "Unable to revoke returned file window grant",
                    reason,
                  ),
                );
              await ports
                .emit(event.payload.windowLabel, "file", "return-complete", {
                  documentId: document.id,
                  token: event.payload.token,
                })
                .catch(() => managedWindow.destroy().catch(() => undefined));
            } catch (reason) {
              if (fileReturnDriverContext) {
                await rollbackWorkspaceContentHandoff(
                  fileReturnDriverContext,
                  fileReturnDriverPayload,
                  reason,
                ).catch(() => undefined);
              }
              deps
                .getCoordinator()
                .failHandoff(
                  fileContentRef(event.payload.documentId),
                  "returnFailed",
                  returnTransferId,
                );
              await ports
                .emit(event.payload.windowLabel, "file", "return-failed", {
                  documentId: event.payload.documentId,
                  token: event.payload.token,
                  message: deps.translate("pty.returnFailed", {
                    error: formatAppError(reason, deps.translate),
                  }),
                })
                .catch(() => undefined);
            }
          }),
      },
    ],
    lostRegistrations: () => [
      {
        name: RUST_EVENTS.workspaceContentWindowLost,
        register: () =>
          onInboxEvent<WorkspaceContentWindowLostEvent>(
            RUST_EVENTS.workspaceContentWindowLost,
            (event) => {
              handleWorkspaceContentWindowLost(event.payload);
            },
          ),
      },
    ],
  };
}

export function startFileListeners(
  handlers: FileProtocolHandlers,
  shell: ProtocolListenerShell,
): () => void {
  const controller = new AbortController();
  let unlisten: () => void = () => undefined;
  const setup = async () => {
    const cleanup = await setupWorkspaceContentListeners({
      registrations: handlers.registrations(),
      signal: controller.signal,
      retryDelaysMs: shell.retryDelaysMs,
      onFailed: (failed) => shell.onFailed("file window", failed),
    });
    unlisten = cleanup;
  };
  void setup().catch((reason) =>
    console.error("File window listener setup failed", reason),
  );
  return () => {
    controller.abort();
    unlisten();
  };
}

export function startWindowLostListeners(
  handlers: FileProtocolHandlers,
  shell: ProtocolListenerShell,
): () => void {
  const controller = new AbortController();
  let unlisten: () => void = () => undefined;
  void setupWorkspaceContentListeners({
    registrations: handlers.lostRegistrations(),
    signal: controller.signal,
    retryDelaysMs: shell.retryDelaysMs,
    onFailed: (failed) => shell.onFailed("content window lost", failed),
  }).then((cleanup) => {
    unlisten = cleanup;
  });
  return () => {
    controller.abort();
    unlisten();
  };
}

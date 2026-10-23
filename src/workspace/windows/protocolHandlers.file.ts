import type { IsolatedRegistration } from "../../lib/retryPolicy";
import { setupWorkspaceContentListeners } from "../../lib/workspaceContentListenerSetup";
import type {
  ContentWindowOrchestrator,
  ManagedFileWindow,
  PendingWorkspaceFileWindow,
  ProtocolListenerShell,
} from "./contentWindowOrchestrator";
import { rollbackHandoffOnce } from "./handoffRollback";
import { acceptWindowReady } from "./pendingHandshake";
import { acceptPendingAttach, failPendingHandoff } from "./pendingHandshake";

import { RUST_EVENTS } from "../../lib/eventNames";
import { windowKindOf } from "../../lib/windowKinds";
import { onInboxEvent } from "../../lib/windowInbox";
import { onContentHandoff } from "../../lib/workspaceContentWindowProtocol";
import {
  findWorkspacePane,
  listWorkspacePanes,
  hasWorkspaceContent,
} from "../../lib/ptyWorkspaceLayout";

import { matchesWorkspaceFileWindow } from "../../lib/workspaceFileWindow";

import {
} from "../../lib/workspaceContentWindowRegistry";
import {
  isWorkspaceFileBufferNewer,
  workspaceFileDocumentIdentityMatches,
} from "../../lib/workspaceFileBuffer";
import { formatAppError } from "../../lib/appErrors";

import { fileContentKey, fileContentRef } from "../../lib/workspaceContentKey";
import { requestWorkspaceFileBufferFlush } from "../../lib/workspaceFileExitFlush";

import { type WorkspaceContentHandoffPayloadByKind } from "../../lib/workspaceContentLifecycle";

import { resolveWorkspaceReturnPaneId } from "../../lib/workspaceContentCommand";
import {
  attachWorkspaceContentHandoff,
} from "../../components/workspaceContentHandoffRuntime";
import type { WorkspaceContentHandoffHookContext } from "../../components/workspaceContentAdapterRegistry";
import { MAIN_WINDOW_LABEL } from "../../lib/windowKinds";

export interface WorkspaceContentWindowLostEvent {
  windowLabel: string;
}

export interface FileProtocolHandlers {
  /** 文件窗组 5 项，与宿主原 effect 的顺序一致。 */
  registrations(): IsolatedRegistration[];
  /** lost 组 1 项。 */
  lostRegistrations(): IsolatedRegistration[];
}

/** The window identity a file child must echo back; `token` is the wire name of the window token. */
function pendingFileIdentity(pending: PendingWorkspaceFileWindow) {
  return {
    documentId: pending.documentId,
    token: pending.windowToken,
    windowLabel: pending.windowLabel,
  };
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
      // F4（m6-096）：返回途中（returning）窗口崩溃的文件同样要收回，它的归属窗口是 source。
      if (state?.phase === "returning") {
        return state.source.windowLabel === windowLabel;
      }
      return (
        state?.phase === "detached" &&
        state.owner.kind === "window" &&
        state.owner.windowLabel === windowLabel
      );
    });
    // 每个文件各一条收回命令（归属登记、树与焦点在执行器里一次提交）。
    for (const content of lost) {
      if (content.kind !== "file") continue;
      state.handles.file.delete(fileContentKey(content.documentId));
      deps.execute({ type: "reclaim", ref: content });
    }
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
              !matchesWorkspaceFileWindow(
                pendingFileIdentity(pending),
                event.payload,
              )
            ) {
              return;
            }
            const content = fileContentRef(pending.documentId);
            const driverContext: WorkspaceContentHandoffHookContext<"file"> = {
              content,
              source: {
                kind: "pane",
                windowLabel: MAIN_WINDOW_LABEL,
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
            await acceptWindowReady(orchestrator, {
              pending,
              pendingMap: state.pending.file,
              key: fileContentKey(pending.documentId),
              ref: content,
              lateReadyMessage: `Ignoring duplicate or late file:ready for ${pending.documentId} (stage ${pending.stage}).`,
              driverContext,
              emitInit: (payload) =>
                ports.emit(pending.windowLabel, "file", "init", {
                  documentId: pending.documentId,
                  token: pending.windowToken,
                  windowLabel: pending.windowLabel,
                  fileDocument: payload.document,
                  fileBuffer: payload.buffer,
                }),
              reasonText: (reason) => formatAppError(reason, deps.translate),
            });
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
              !matchesWorkspaceFileWindow(
                pendingFileIdentity(pending),
                event.payload,
              )
            ) {
              return;
            }
            // 只有 init 已发出（阶段为 initSent）的 pending 才接受 attached；阶段校验在共享握手中完成。
            acceptPendingAttach(orchestrator, pending, {
              pending: state.pending.file,
              detached: state.handles.file,
              key: fileContentKey(pending.documentId),
              ref: fileContentRef(pending.documentId),
              toDetached: (record) => record.window,
            });
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
              !matchesWorkspaceFileWindow(
                pendingFileIdentity(pending),
                event.payload,
              )
            ) {
              return;
            }
            failPendingHandoff(orchestrator, pending, {
              pendingMap: state.pending.file,
              key: fileContentKey(pending.documentId),
              ref: fileContentRef(pending.documentId),
              message:
                event.payload.message ??
                deps.translate("pty.detachedStartFailed"),
            });
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
                    windowLabel: MAIN_WINDOW_LABEL,
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
                MAIN_WINDOW_LABEL,
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
                  windowLabel: MAIN_WINDOW_LABEL,
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
              // 目标 pane 以 beginReturn 时协调器记录的为准（returnReady 把 owner 设为它）。
              // 计算、归属登记与树提交都在执行器里完成；归属被拒绝时树保持原样，子窗口仍可重试。
              const recordedPaneId = activeReturn.target.paneId;
              const outcome = deps.execute({
                type: "completeReturn",
                ref: fileContentRef(document.id),
                token: returnTransferId,
                requestedPaneId: recordedPaneId,
                expectedPaneId: recordedPaneId,
                whenAlreadyInTree: "relocate",
              });
              if (outcome.status === "ignored") {
                if (outcome.reason !== "handoff-not-current") {
                  throw new Error(deps.translate("pty.workspaceRestoring"));
                }
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
                await rollbackHandoffOnce(
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

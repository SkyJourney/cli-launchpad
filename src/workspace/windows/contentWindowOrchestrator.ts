import type { TFunction } from "i18next";
import type { PtyTerminalHandle } from "../../components/PtyTerminal";
import type { IsolatedRegistrationFailure } from "../../lib/retryPolicy";
import type { WorkspaceFileBuffer } from "../../lib/workspaceFileBuffer";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

import { createWindowLabel } from "../../lib/windowKinds";
import { emitWorkspaceContentWindowEvent } from "../../lib/workspaceContentWindowProtocol";
import {
  type WorkspaceNode,
  findWorkspacePane,
  listWorkspacePanes,
  hasWorkspaceContent,
} from "../../lib/ptyWorkspaceLayout";
import {
  nextOwnerQueryStep,
  PTY_OWNER_QUERY_MAX_RETRIES,
  PTY_OWNER_QUERY_RETRY_DELAY_MS,
  resolveDetachedStartTimeoutAction,
} from "../../lib/ptySessionLifecycle";

import {
  clearPendingWorkspaceContentWindows,
  registerPendingWorkspaceContentWindow,
  retainAsyncUnlisten,
  takePendingWorkspaceContentWindow,
  type WorkspaceContentWindowRecord,
} from "../../lib/workspaceContentWindowRegistry";
import {
  advancePendingWindowStage,
  initialPendingStage,
  type PendingWindowStage,
} from "../../lib/workspaceContentPendingStage";
import {
  getPtySessionWindowStatus,
  grantContentWindowFile,
  revokeContentWindowFile,
} from "../../lib/tauri";
import {
  isWindowOwned,
  ownerWindowOf,
} from "../../lib/workspaceOwnershipProjection";
import { formatAppError } from "../../lib/appErrors";

import type { WorkspaceContentCoordinator } from "../../lib/workspaceContentCoordinator";
import { fileContentKey, ptyContentKey } from "../../lib/workspaceContentKey";

import { type WorkspaceContentHandoffPayloadByKind } from "../../lib/workspaceContentLifecycle";

import { writeWindowLaunchParams } from "./windowLaunchParams";

import type { WorkspaceHostStore } from "../host/workspaceHostStore";
import { reduceWorkspaceTree } from "../../lib/workspaceContentCommand";
import {
  createWorkspaceContentWindow,
  prepareWorkspaceContentHandoff,
  rollbackWorkspaceContentHandoff,
  WORKSPACE_CONTENT_WINDOW_HANDOFF_TIMEOUT_MS,
} from "../../components/workspaceContentHandoffRuntime";
import type { WorkspaceContentHandoffHookContext } from "../../components/workspaceContentAdapterRegistry";

export interface DetachedWindowRecord {
  instanceId: string;
  sessionId: string;
  windowLabel: string;
}

export interface PendingContentWindow<
  K extends "pty" | "file",
> extends WorkspaceContentWindowRecord {
  kind: K;
  stage: PendingWindowStage;
  token: string;
  window: WebviewWindow;
  resolve: () => void;
  reject: (reason: Error) => void;
  handoffContext?: WorkspaceContentHandoffHookContext<K>;
  handoffPayload?: WorkspaceContentHandoffPayloadByKind[K];
}

export type PendingDetachedWindow = PendingContentWindow<"pty"> &
  DetachedWindowRecord & {
    handoffContext: WorkspaceContentHandoffHookContext<"pty">;
    handoffPayload: WorkspaceContentHandoffPayloadByKind["pty"];
    /** 对账时 owner 查询已连续失败的次数；随 tracked 展开复制。 */
    ownerQueryRetries?: number;
  };

export interface DetachedWindowReadyEvent extends DetachedWindowRecord {}

export interface PtySessionOwnerLostEvent {
  sessionId: string;
}

export interface PtyReturnRequestEvent extends DetachedWindowRecord {
  token: string;
  targetPaneId?: string;
}

export interface PendingWorkspaceFileWindow extends PendingContentWindow<"file"> {
  documentId: string;
  sourcePaneId?: string;
}
export interface ManagedFileWindow {
  documentId: string;
  token: string;
  windowLabel: string;
}

export interface ContentWindowState {
  /** 已附着窗口的句柄，按内容键（ptyContentKey / fileContentKey）索引。 */
  handles: {
    pty: Map<string, WebviewWindow>;
    file: Map<string, WebviewWindow>;
  };
  /** 正在创建、握手尚未完成的窗口。 */
  pending: {
    pty: Map<string, PendingDetachedWindow>;
    file: Map<string, PendingWorkspaceFileWindow>;
  };
  /** PTY 返回流程的等待中止器。 */
  returnWaitAbort: { current: AbortController | null };
  /** Aborted when the host unmounts; replaced by a fresh controller right after, so a remount starts clean. */
  lifecycleAbort: { current: AbortController };
}

export function createContentWindowState(): ContentWindowState {
  return {
    handles: { pty: new Map(), file: new Map() },
    pending: { pty: new Map(), file: new Map() },
    returnWaitAbort: { current: null },
    lifecycleAbort: { current: new AbortController() },
  };
}

export interface ContentWindowPorts {
  createWindow: typeof createWorkspaceContentWindow;
  getWindowByLabel: (label: string) => Promise<WebviewWindow | null>;
  getPtySessionWindowStatus: typeof getPtySessionWindowStatus;
  grantFile: typeof grantContentWindowFile;
  revokeFile: typeof revokeContentWindowFile;
  emit: typeof emitWorkspaceContentWindowEvent;
}

export interface ContentWindowDeps {
  store: WorkspaceHostStore;
  getCoordinator: () => WorkspaceContentCoordinator;
  translate: TFunction;
  commitTree: (next: WorkspaceNode) => void;
  setFocusedPane: (paneId: string) => void;
  removeSlot: (instanceId: string) => void;
  loadFile: (documentId: string) => Promise<void>;
  waitForFileSave: (documentId: string) => Promise<void>;
  mergeFileBuffers: (
    entries: Record<string, WorkspaceFileBuffer>,
    reason: string,
  ) => void;
  terminalOf: (instanceId: string) => PtyTerminalHandle | undefined;
  titleOfPty: (instanceId: string) => string;
  openDirectory: (directoryId: number) => void;
  ports?: Partial<ContentWindowPorts>;
}

export interface ContentWindowOrchestrator {
  readonly state: ContentWindowState;
  readonly deps: ContentWindowDeps;
  readonly ports: ContentWindowPorts;
  detachFile(documentId: string): Promise<void>;
  detachSession(instanceId: string): Promise<void>;
  reconcileTimedOutDetach(pending: PendingDetachedWindow): Promise<void>;
  isManagedDetachedDrag(instanceId: string, windowLabel: string): boolean;
  isManagedDetachedFileDrag(documentId: string, windowLabel: string): boolean;
  rollbackPending(): void;
  forgetHandles(): void;
  disposeAll(): void;
  abortReturnWait(): void; // 仅卸载时调用：同时中止 owner-lost 生命周期信号并换新控制器，运行中途不得调用
  listManagedFileWindows(): ManagedFileWindow[];
}

export const defaultContentWindowPorts: ContentWindowPorts = {
  createWindow: createWorkspaceContentWindow,
  getWindowByLabel: (label) => WebviewWindow.getByLabel(label),
  getPtySessionWindowStatus,
  grantFile: grantContentWindowFile,
  revokeFile: revokeContentWindowFile,
  emit: emitWorkspaceContentWindowEvent,
};

/** 构造的 deps 每个成员都调用 ref 里最新的 deps（R-FE-1：不读取创建时的闭包值）。 */
export function latestContentWindowDeps(ref: {
  current: ContentWindowDeps | null;
}): ContentWindowDeps {
  const current = (): ContentWindowDeps => {
    if (!ref.current) throw new Error("content window deps are not ready");
    return ref.current;
  };
  return {
    get store() {
      return current().store;
    },
    getCoordinator: () => current().getCoordinator(),
    get translate() {
      return current().translate;
    },
    commitTree: (next) => current().commitTree(next),
    setFocusedPane: (paneId) => current().setFocusedPane(paneId),
    removeSlot: (instanceId) => current().removeSlot(instanceId),
    loadFile: (documentId) => current().loadFile(documentId),
    waitForFileSave: (documentId) => current().waitForFileSave(documentId),
    mergeFileBuffers: (entries, reason) =>
      current().mergeFileBuffers(entries, reason),
    terminalOf: (instanceId) => current().terminalOf(instanceId),
    titleOfPty: (instanceId) => current().titleOfPty(instanceId),
    openDirectory: (directoryId) => current().openDirectory(directoryId),
    get ports() {
      return ref.current?.ports;
    },
  };
}

/** 监听外壳：监听组需要的重试间隔与失败报告，由宿主注入。 */
export interface ProtocolListenerShell {
  retryDelaysMs: readonly number[];
  onFailed: (group: string, failed: IsolatedRegistrationFailure[]) => void;
}

export function createContentWindowOrchestrator(
  deps: ContentWindowDeps,
): ContentWindowOrchestrator {
  const state = createContentWindowState();
  const ports: ContentWindowPorts = {
    ...defaultContentWindowPorts,
    ...deps.ports,
  };

  const isManagedDetachedDrag = (instanceId: string, windowLabel: string) => {
    const ownership = deps.getCoordinator().get({
      kind: "pty",
      slotId: instanceId,
    });
    return (
      ownership?.phase === "detached" &&
      ownership.owner.kind === "window" &&
      ownership.owner.windowLabel === windowLabel
    );
  };
  const isManagedDetachedFileDrag = (
    documentId: string,
    windowLabel: string,
  ) => {
    const ownership = deps.getCoordinator().get({
      kind: "file",
      documentId,
    });
    return (
      ownership?.phase === "detached" &&
      ownership.owner.kind === "window" &&
      ownership.owner.windowLabel === windowLabel
    );
  };
  // 结算挂起的 detach/return 承诺并销毁尚未附着的窗口（hydrate 与 rehydrate 共用）。
  const rollbackPending = () => {
    clearPendingWorkspaceContentWindows(state.pending.pty, (pending) => {
      deps
        .getCoordinator()
        .failHandoff(
          { kind: "pty", slotId: pending.instanceId },
          "detachCancelled",
          pending.token,
        );
      pending.reject(new Error(deps.translate("pty.detachedStateChanged")));
      void pending.window.destroy().catch(() => undefined);
    });
    clearPendingWorkspaceContentWindows(state.pending.file, (pending) => {
      deps
        .getCoordinator()
        .failHandoff(
          { kind: "file", documentId: pending.documentId },
          "detachCancelled",
          pending.token,
        );
      pending.reject(new Error(deps.translate("pty.detachedStateChanged")));
      void pending.window.destroy().catch(() => undefined);
    });
  };
  // 只遗忘已附着窗口的句柄，从不调用 destroy()（已附着窗口可能有未保存编辑）。
  const forgetHandles = () => {
    state.handles.pty.clear();
    state.handles.file.clear();
  };
  const disposeAll = () => {
    const cleanupError = new Error("工作区内容宿主已卸载");
    clearPendingWorkspaceContentWindows(state.pending.pty, (pending) => {
      void rollbackWorkspaceContentHandoff(
        pending.handoffContext,
        pending.handoffPayload,
        cleanupError,
      ).catch(() => undefined);
      deps
        .getCoordinator()
        .failHandoff(
          { kind: "pty", slotId: pending.instanceId },
          "detachCancelled",
          pending.token,
        );
      pending.reject(cleanupError);
      void pending.window.destroy().catch(() => undefined);
    });
    clearPendingWorkspaceContentWindows(state.pending.file, (pending) => {
      if (pending.handoffContext) {
        void rollbackWorkspaceContentHandoff(
          pending.handoffContext,
          pending.handoffPayload,
          cleanupError,
        ).catch(() => undefined);
      }
      deps
        .getCoordinator()
        .failHandoff(
          { kind: "file", documentId: pending.documentId },
          "detachCancelled",
          pending.token,
        );
      pending.reject(cleanupError);
      void pending.window.destroy().catch(() => undefined);
    });
  };
  const listManagedFileWindows = (): ManagedFileWindow[] => {
    const managedWindows = new Map<
      string,
      { documentId: string; token: string; windowLabel: string }
    >();
    for (const content of deps.getCoordinator().listWindowOwned()) {
      if (content.kind !== "file") continue;
      const ownership = deps.getCoordinator().get(content);
      if (!ownership) continue;
      const owner = ownerWindowOf(ownership);
      if (owner && owner.windowToken) {
        managedWindows.set(content.documentId, {
          documentId: content.documentId,
          token: owner.windowToken,
          windowLabel: owner.windowLabel,
        });
      }
    }
    for (const pending of state.pending.file.values()) {
      managedWindows.set(pending.documentId, {
        documentId: pending.documentId,
        token: pending.token,
        windowLabel: pending.windowLabel,
      });
    }
    return [...managedWindows.values()];
  };

  const detachFile = async (documentId: string) => {
    const content = { kind: "file", documentId } as const;
    if (isWindowOwned(deps.getCoordinator().get(content))) {
      return;
    }
    const sourcePane = listWorkspacePanes(deps.store.getLive().tree).find(
      (pane) => hasWorkspaceContent(pane, content),
    );
    if (!sourcePane)
      throw new Error(deps.translate("workspaceFiles.loadingFile"));
    const token = crypto.randomUUID();
    const windowLabel = createWindowLabel("workspaceContent");
    let grantedWindowLabel: string | undefined;
    let lifecycleStarted = false;
    try {
      const lifecycle = deps
        .getCoordinator()
        .beginDetach(
          content,
          { kind: "pane", windowLabel: "main", paneId: sourcePane.id },
          { kind: "window", windowLabel },
          token,
        );
      if (lifecycle?.outcome !== "changed") {
        throw new Error(deps.translate("pty.detachedMoveUnavailable"));
      }
      lifecycleStarted = true;
      grantedWindowLabel = windowLabel;
      if (!deps.store.getLive().buffers[documentId])
        await deps.loadFile(documentId);
      await deps.waitForFileSave(documentId);
      const fileBuffer = deps.store.getLive().buffers[documentId];
      const fileDocument = deps.store
        .getLive()
        .documents.find((document) => document.id === documentId);
      if (!fileDocument || !fileBuffer || fileBuffer.saving) {
        throw new Error(deps.translate("workspaceFiles.loadingFile"));
      }
      await ports.grantFile(
        windowLabel,
        fileDocument.directoryId,
        fileDocument.directoryPath,
        fileDocument.relativePath,
      );
      const childUrl = new URL(window.location.href);
      childUrl.search = "";
      childUrl.hash = "";
      writeWindowLaunchParams(childUrl.searchParams, {
        kind: "file",
        documentId,
        handoffToken: token,
        sourcePaneId: sourcePane.id,
      });
      await new Promise<void>((resolve, reject) => {
        const child = ports.createWindow({
          label: windowLabel,
          url: `${childUrl.pathname}${childUrl.search}${childUrl.hash}`,
          title:
            fileDocument.relativePath.split("/").pop() ??
            fileDocument.relativePath,
        });
        const failCreation = (reason: unknown) => {
          const pending = takePendingWorkspaceContentWindow(
            state.pending.file,
            fileContentKey(documentId),
            windowLabel,
          );
          if (!pending) return;
          reject(new Error(formatAppError(reason, deps.translate)));
        };
        const cleanupCreationErrorListener = retainAsyncUnlisten(
          () =>
            child.once("tauri://error", (event) => {
              failCreation(
                event.payload == null
                  ? deps.translate("pty.detachedCreateFailed")
                  : event.payload,
              );
            }),
          failCreation,
        );
        registerPendingWorkspaceContentWindow({
          pending: state.pending.file,
          key: fileContentKey(documentId),
          timeoutMs: WORKSPACE_CONTENT_WINDOW_HANDOFF_TIMEOUT_MS,
          onTimeout: () => {
            void child.destroy().catch(() => undefined);
            reject(new Error(deps.translate("pty.detachedStartTimedOut")));
          },
          record: {
            documentId,
            token,
            windowLabel,
            sourcePaneId: sourcePane.id,
            window: child,
            cleanup: cleanupCreationErrorListener,
            resolve,
            reject,
            kind: "file",
            stage: initialPendingStage("file"),
          },
        });
      });
    } catch (reason) {
      if (grantedWindowLabel) {
        await ports
          .revokeFile(grantedWindowLabel)
          .catch((revokeError) =>
            console.warn(
              "Unable to revoke failed file window grant",
              revokeError,
            ),
          );
      }
      if (lifecycleStarted && token) {
        deps.getCoordinator().failHandoff(content, "detachFailed", token);
      }
      throw reason;
    }
  };
  const reconcileTimedOutDetach = async (pending: PendingDetachedWindow) => {
    const key = ptyContentKey(pending.instanceId);
    const current = state.pending.pty.get(key);
    if (current && current.windowLabel !== pending.windowLabel) return;
    if (current) window.clearTimeout(current.timer);
    let tracked: PendingDetachedWindow;
    const timer = window.setTimeout(() => {
      if (state.pending.pty.get(key) === tracked) {
        state.pending.pty.delete(key);
        void reconcileTimedOutDetach(tracked);
      }
    }, PTY_OWNER_QUERY_RETRY_DELAY_MS);
    tracked = { ...(current ?? pending), timer };
    state.pending.pty.set(key, tracked);

    const [status, child] = await Promise.all([
      ports.getPtySessionWindowStatus(pending.sessionId).catch(() => null),
      ports.getWindowByLabel(pending.windowLabel).catch(() => null),
    ]);
    if (state.pending.pty.get(key) !== tracked) return;
    const action = resolveDetachedStartTimeoutAction(status, {
      expectedChildLabel: pending.windowLabel,
      childExists: Boolean(child),
    });

    let effectiveAction = action;
    if (action === "retry-owner-query") {
      const step = nextOwnerQueryStep(tracked.ownerQueryRetries ?? 0);
      if (step.kind === "retry") {
        tracked.ownerQueryRetries = step.retries;
        console.warn(
          `Unable to verify PTY detach owner for session ${pending.sessionId}; retry ${step.retries} of ${PTY_OWNER_QUERY_MAX_RETRIES} without closing either window.`,
        );
        return;
      }
      console.warn(
        `Giving up verifying PTY detach owner for session ${pending.sessionId}; rolling the detach back.`,
      );
      effectiveAction = "cancel-source-handoff";
    }

    if (effectiveAction === "accept-detached-owner") {
      if (!advancePendingWindowStage(tracked, "attachedAck")) return;
      const ownership = deps
        .getCoordinator()
        .completeHandoff(
          { kind: "pty", slotId: pending.instanceId },
          "detachReady",
          pending.token,
        );
      if (ownership?.outcome !== "changed") {
        await rollbackWorkspaceContentHandoff(
          pending.handoffContext,
          pending.handoffPayload,
          new Error(deps.translate("pty.detachedStateChanged")),
        ).catch(() => undefined);
        takePendingWorkspaceContentWindow(
          state.pending.pty,
          ptyContentKey(pending.instanceId),
          pending.windowLabel,
        );
        pending.reject(new Error(deps.translate("pty.detachedStateChanged")));
        return;
      }
      const promoted = takePendingWorkspaceContentWindow(
        state.pending.pty,
        ptyContentKey(pending.instanceId),
        pending.windowLabel,
      );
      if (!promoted) return;
      state.handles.pty.set(ptyContentKey(pending.instanceId), pending.window);
      const content = {
        kind: "pty",
        slotId: pending.instanceId,
      } as const;
      const nextTree = reduceWorkspaceTree(deps.store.getLive().tree, {
        type: "detach",
        ref: content,
      });
      deps.commitTree(nextTree);
      if (!findWorkspacePane(nextTree, deps.store.getLive().focusedPaneId)) {
        deps.setFocusedPane(listWorkspacePanes(nextTree)[0].id);
      }
      pending.resolve();
      return;
    }

    takePendingWorkspaceContentWindow(
      state.pending.pty,
      ptyContentKey(pending.instanceId),
      pending.windowLabel,
    );
    if (effectiveAction === "remove-ended-session") {
      void pending.window.destroy().catch(() => undefined);
      deps
        .getCoordinator()
        .failHandoff(
          { kind: "pty", slotId: pending.instanceId },
          "detachFailed",
          pending.token,
        );
      pending.reject(new Error(deps.translate("pty.detachedStartFailed")));
      deps.removeSlot(pending.instanceId);
      return;
    }

    const failureMessage =
      effectiveAction === "reject-foreign-owner"
        ? deps.translate("pty.detachedStateChanged")
        : deps.translate("pty.detachedStartTimedOut");
    await rollbackWorkspaceContentHandoff(
      pending.handoffContext,
      pending.handoffPayload,
      new Error(failureMessage),
    ).catch(() => undefined);
    deps
      .getCoordinator()
      .failHandoff(
        { kind: "pty", slotId: pending.instanceId },
        "detachFailed",
        pending.token,
      );
    void pending.window.destroy().catch(() => undefined);
    pending.reject(new Error(failureMessage));
  };
  const detachSession = async (instanceId: string) => {
    const slot = deps.store
      .getLive()
      .slots.find((candidate) => candidate.instanceId === instanceId);
    const sessionId = slot?.sessionId;
    if (
      !slot ||
      !sessionId ||
      isWindowOwned(
        deps.getCoordinator().get({
          kind: "pty",
          slotId: instanceId,
        }),
      )
    ) {
      throw new Error(deps.translate("pty.detachedMoveUnavailable"));
    }
    const currentSession = deps.store.getLive().ptySessionsById[sessionId];
    if (currentSession?.state !== "running") {
      throw new Error(deps.translate("pty.detachedMoveNotRunning"));
    }
    const terminal = deps.terminalOf(instanceId);
    if (!terminal) throw new Error(deps.translate("pty.terminalNotReady"));
    const windowLabel = createWindowLabel("terminal");
    const sourcePane = listWorkspacePanes(deps.store.getLive().tree).find(
      (pane) => hasWorkspaceContent(pane, { kind: "pty", slotId: instanceId }),
    );
    if (!sourcePane)
      throw new Error(deps.translate("pty.detachedMoveUnavailable"));
    const content = { kind: "pty", slotId: instanceId } as const;
    const source = {
      kind: "pane",
      windowLabel: "main",
      paneId: sourcePane.id,
    } as const;
    const target = { kind: "window", windowLabel } as const;
    const ownerState = deps.getCoordinator().ensureAttached(content, source);
    if (ownerState.phase !== "attached") {
      throw new Error(deps.translate("pty.terminating"));
    }
    let driverContext: WorkspaceContentHandoffHookContext<"pty"> = {
      content,
      source,
      target,
      transferId: crypto.randomUUID(),
      capabilities: {
        prepare: async () => ({
          handoff: await terminal.captureHandoff(windowLabel),
        }),
        attach: async (payload) => {
          await terminal.attachHandoff(sessionId, payload.handoff.token);
        },
        rollback: async (payload) => {
          if (payload) await terminal.cancelHandoff(payload.handoff.token);
        },
      },
    };
    const prepared = await prepareWorkspaceContentHandoff(driverContext);
    driverContext = { ...driverContext, transferId: prepared.transferId };
    const handoff = prepared.payload.handoff;
    const lifecycle = deps
      .getCoordinator()
      .beginDetach(content, source, target, prepared.transferId);
    if (lifecycle?.outcome !== "changed") {
      await rollbackWorkspaceContentHandoff(
        driverContext,
        prepared.payload,
        new Error(deps.translate("pty.detachedMoveUnavailable")),
      ).catch(() => undefined);
      throw new Error(deps.translate("pty.detachedMoveUnavailable"));
    }
    const detachedRecord = { instanceId, sessionId, windowLabel };
    const title = deps.titleOfPty(instanceId);
    const childUrl = new URL(window.location.href);
    childUrl.search = "";
    childUrl.hash = "";
    writeWindowLaunchParams(childUrl.searchParams, {
      kind: "pty",
      sessionId,
      handoffToken: handoff.token,
      instanceId,
      title,
      toolKey: slot.toolKey,
      sourcePaneId: sourcePane.id,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const child = ports.createWindow({
          label: windowLabel,
          url: `${childUrl.pathname}${childUrl.search}${childUrl.hash}`,
          title,
        });
        const failCreation = (reason: unknown) => {
          const pending = takePendingWorkspaceContentWindow(
            state.pending.pty,
            ptyContentKey(instanceId),
            windowLabel,
          );
          if (!pending) return;
          reject(new Error(formatAppError(reason, deps.translate)));
        };
        const cleanupCreationErrorListener = retainAsyncUnlisten(
          () =>
            child.once("tauri://error", (event) => {
              failCreation(
                event.payload == null
                  ? deps.translate("pty.detachedCreateFailed")
                  : event.payload,
              );
            }),
          failCreation,
        );
        registerPendingWorkspaceContentWindow({
          pending: state.pending.pty,
          key: ptyContentKey(instanceId),
          timeoutMs: WORKSPACE_CONTENT_WINDOW_HANDOFF_TIMEOUT_MS,
          onTimeout: (pending) => {
            void reconcileTimedOutDetach(pending);
          },
          record: {
            ...detachedRecord,
            kind: "pty",
            stage: initialPendingStage("pty"),
            token: handoff.token,
            resolve,
            reject,
            window: child,
            cleanup: cleanupCreationErrorListener,
            handoffContext: driverContext,
            handoffPayload: prepared.payload,
          },
        });
      });
    } catch (reason) {
      await rollbackWorkspaceContentHandoff(
        driverContext,
        prepared.payload,
        reason,
      ).catch(() => undefined);
      deps
        .getCoordinator()
        .failHandoff(
          { kind: "pty", slotId: instanceId },
          "detachFailed",
          prepared.transferId,
        );
      throw reason;
    }
  };

  const abortReturnWait = () => {
    state.returnWaitAbort.current?.abort();
    state.returnWaitAbort.current = null;
    state.lifecycleAbort.current.abort();
    state.lifecycleAbort.current = new AbortController();
  };

  return {
    state,
    deps,
    ports,
    detachFile,
    detachSession,
    reconcileTimedOutDetach,
    isManagedDetachedDrag,
    isManagedDetachedFileDrag,
    rollbackPending,
    forgetHandles,
    disposeAll,
    abortReturnWait,
    listManagedFileWindows,
  };
}

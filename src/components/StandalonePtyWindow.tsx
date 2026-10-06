import { getCurrentWindow } from "@tauri-apps/api/window";
import { ArrowLeft, Terminal as TerminalIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PtySession, ToolKey } from "../lib/tauri";
import { formatAppError } from "../lib/appErrors";
import { TOOLS } from "../lib/tools";
import { PtyTerminal, type PtyTerminalHandle } from "./PtyTerminal";
import { WorkspaceContentWindowShell } from "./WorkspaceContentWindowShell";
import { tryGetWorkspaceContentAdapter } from "./WorkspaceContentView";
import {
  getPtySessionWindowStatus,
  type PtySessionWindowStatus,
} from "../lib/tauri";
import {
  encodePtySessionDrag,
  PTY_SESSION_DRAG_TYPE,
} from "../lib/ptySessionDrag";
import {
  encodeWorkspaceContentDrag,
  WORKSPACE_CONTENT_DRAG_TYPE,
} from "../lib/workspaceContentDrag";
import { resolveDetachedWindowFailureAction } from "../lib/ptySessionLifecycle";
import {
  emitWorkspaceContentWindowEvent,
  listenWorkspaceContentWindowEvent,
} from "../lib/workspaceContentWindowProtocol";
import {
  attachWorkspaceContentHandoff,
  prepareWorkspaceContentHandoff,
  rollbackWorkspaceContentHandoff,
  WORKSPACE_CONTENT_WINDOW_HANDOFF_TIMEOUT_MS,
} from "./workspaceContentHandoffRuntime";
import type { WorkspaceContentHandoffHookContext } from "./workspaceContentAdapterRegistry";

interface StandalonePtyWindowProps {
  sessionId: string;
  handoffToken: string;
  instanceId: string;
  sourcePaneId: string;
  toolKey?: ToolKey;
  title: string;
}

const RETURN_HANDOFF_TIMEOUT_MS = WORKSPACE_CONTENT_WINDOW_HANDOFF_TIMEOUT_MS;

export function StandalonePtyWindow({
  sessionId,
  handoffToken,
  instanceId,
  sourcePaneId,
  toolKey,
  title,
}: StandalonePtyWindowProps) {
  const { t } = useTranslation();
  const terminalRef = useRef<PtyTerminalHandle>(null);
  const ToolIcon = TOOLS.find((tool) => tool.key === toolKey)?.icon;
  const exitHandledRef = useRef(false);
  const returnInProgressRef = useRef(false);
  const returnAttemptRef = useRef(0);
  const currentReturnTokenRef = useRef(handoffToken);
  const returnHandoffContextRef =
    useRef<WorkspaceContentHandoffHookContext<"pty"> | null>(null);
  const returnHandoffPayloadRef = useRef<
    { handoff: { token: string; sequence?: number } } | undefined
  >(undefined);
  const returnTimeoutRef = useRef<number | null>(null);
  const handoffStartedRef = useRef(false);
  const closeAfterExitRef = useRef<() => void>(() => undefined);
  const closeAfterTransferRef = useRef<() => void>(() => undefined);
  const translationRef = useRef(t);
  translationRef.current = t;
  const [ready, setReady] = useState(false);
  const readyRef = useRef(ready);
  readyRef.current = ready;
  const [returning, setReturning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reconcileWindowStatus = useCallback(async () => {
    let windowStatus: PtySessionWindowStatus;
    try {
      windowStatus = await getPtySessionWindowStatus(sessionId);
    } catch (reason) {
      console.warn("Failed to reconcile detached PTY status", reason);
      return false;
    }

    const action = resolveDetachedWindowFailureAction(
      terminalRef.current?.getSessionState(),
      windowStatus,
    );
    if (action === "close-ended") {
      closeAfterExitRef.current();
      return true;
    }
    if (action === "close-transferred") {
      closeAfterTransferRef.current();
      return true;
    }
    return false;
  }, [sessionId]);

  const requestReturn = useCallback(
    async (targetPaneId?: string) => {
      if (returnInProgressRef.current) return;
      const attempt = ++returnAttemptRef.current;
      const isCurrentAttempt = () => returnAttemptRef.current === attempt;
      returnInProgressRef.current = true;
      returnHandoffContextRef.current = null;
      returnHandoffPayloadRef.current = undefined;
      setReturning(true);
      setError(null);
      let token: string | null = null;
      const terminal = terminalRef.current;
      let driverContext: WorkspaceContentHandoffHookContext<"pty"> | null =
        null;
      let handoffPayload:
        | { handoff: { token: string; sequence?: number } }
        | undefined;
      returnTimeoutRef.current = window.setTimeout(() => {
        if (!isCurrentAttempt()) return;
        returnTimeoutRef.current = null;
        const timeoutAttempt = ++returnAttemptRef.current;
        if (driverContext) {
          void rollbackWorkspaceContentHandoff(
            driverContext,
            handoffPayload,
            new Error(t("pty.returnTimedOut")),
          ).catch(() => undefined);
        }
        void reconcileWindowStatus().then((handled) => {
          if (returnAttemptRef.current !== timeoutAttempt || handled) return;
          setError(t("pty.returnFailed", { error: t("pty.returnTimedOut") }));
          returnInProgressRef.current = false;
          setReturning(false);
        });
      }, RETURN_HANDOFF_TIMEOUT_MS);
      try {
        if (!terminal) throw new Error(t("pty.terminalNotReady"));
        const currentWindow = getCurrentWindow();
        driverContext = {
          content: { kind: "pty", slotId: instanceId },
          source: { kind: "window", windowLabel: currentWindow.label },
          target: {
            kind: "pane",
            windowLabel: "main",
            paneId: targetPaneId ?? sourcePaneId,
          },
          transferId: crypto.randomUUID(),
          capabilities: {
            prepare: async () => ({ handoff: await terminal.captureHandoff() }),
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
        handoffPayload = prepared.payload;
        returnHandoffContextRef.current = driverContext;
        returnHandoffPayloadRef.current = prepared.payload;
        token = prepared.transferId;
        currentReturnTokenRef.current = prepared.transferId;
        if (!isCurrentAttempt()) {
          await rollbackWorkspaceContentHandoff(
            driverContext,
            prepared.payload,
            new Error("返回请求已过期"),
          ).catch(() => undefined);
          return;
        }
        await emitWorkspaceContentWindowEvent("main", "pty-return-requested", {
          instanceId,
          sessionId,
          windowLabel: currentWindow.label,
          token: prepared.transferId,
          targetPaneId,
        });
        if (!isCurrentAttempt()) {
          await rollbackWorkspaceContentHandoff(
            driverContext,
            prepared.payload,
            new Error("返回请求已过期"),
          ).catch(() => undefined);
        }
      } catch (reason) {
        if (driverContext && token) {
          await rollbackWorkspaceContentHandoff(
            driverContext,
            handoffPayload,
            reason,
          ).catch(() => undefined);
        }
        if (!isCurrentAttempt()) return;
        if (await reconcileWindowStatus()) return;
        if (!isCurrentAttempt()) return;
        if (returnTimeoutRef.current !== null) {
          window.clearTimeout(returnTimeoutRef.current);
          returnTimeoutRef.current = null;
        }
        returnAttemptRef.current += 1;
        setError(t("pty.returnFailed", { error: formatAppError(reason, t) }));
        returnInProgressRef.current = false;
        setReturning(false);
      }
    },
    [instanceId, reconcileWindowStatus, sessionId, sourcePaneId, t],
  );
  const requestReturnRef = useRef(requestReturn);
  requestReturnRef.current = requestReturn;

  const reportExited = useCallback(
    () =>
      emitWorkspaceContentWindowEvent("main", "pty-detached-exited", {
        instanceId,
        sessionId,
        windowLabel: getCurrentWindow().label,
      }).catch((reason) => {
        console.warn("Failed to report detached PTY exit", reason);
      }),
    [instanceId, sessionId],
  );

  const closeDetachedWindow = useCallback(
    async (reportExit: boolean) => {
      if (exitHandledRef.current) return;
      exitHandledRef.current = true;
      returnAttemptRef.current += 1;
      returnInProgressRef.current = false;
      setReturning(false);
      if (returnTimeoutRef.current !== null) {
        window.clearTimeout(returnTimeoutRef.current);
        returnTimeoutRef.current = null;
      }
      if (reportExit) await reportExited();
      await getCurrentWindow()
        .destroy()
        .catch((reason) =>
          console.error("Failed to destroy detached PTY window", reason),
        );
    },
    [reportExited],
  );
  const closeAfterExit = useCallback(
    () => void closeDetachedWindow(true),
    [closeDetachedWindow],
  );
  const closeAfterTransfer = useCallback(
    () => void closeDetachedWindow(false),
    [closeDetachedWindow],
  );
  closeAfterExitRef.current = closeAfterExit;
  closeAfterTransferRef.current = closeAfterTransfer;

  const handleSessionChange = useCallback(
    (session: { state: string } | null) => {
      if (
        session?.state !== "exited" &&
        session?.state !== "terminated" &&
        session?.state !== "failed"
      ) {
        return;
      }
      closeAfterExitRef.current();
    },
    [],
  );

  const handleWindowCloseRequest = useCallback(() => {
    const currentWindow = getCurrentWindow();
    const terminalState = terminalRef.current?.getSessionState();
    if (
      terminalState === "exited" ||
      terminalState === "terminated" ||
      terminalState === "failed"
    ) {
      closeAfterExitRef.current();
      return;
    }
    if (!readyRef.current && terminalState !== "running") {
      void getPtySessionWindowStatus(sessionId)
        .then((status) => {
          if (status === "ended") {
            closeAfterExitRef.current();
          } else if (status === "ownedByAnotherWindow") {
            emitWorkspaceContentWindowEvent("main", "pty-detached-failed", {
              instanceId,
              sessionId,
              windowLabel: currentWindow.label,
              message: translationRef.current("pty.detachedClosedBeforeReady"),
            }).catch(() => undefined);
            closeAfterTransferRef.current();
          } else {
            void requestReturnRef.current();
          }
        })
        .catch((reason) =>
          console.warn("Failed to inspect PTY before closing", reason),
        );
      return;
    }
    void requestReturnRef.current();
  }, [instanceId, sessionId]);

  useEffect(() => {
    let disposed = false;
    const unlisteners: (() => void)[] = [];
    const setup = async () => {
      const currentWindow = getCurrentWindow();
      try {
        const registeredListeners = await Promise.all([
          listenWorkspaceContentWindowEvent("pty-return-complete", (event) => {
            if (
              event.payload.instanceId !== instanceId ||
              event.payload.token !== currentReturnTokenRef.current
            ) {
              return;
            }
            returnAttemptRef.current += 1;
            returnHandoffContextRef.current = null;
            returnHandoffPayloadRef.current = undefined;
            if (returnTimeoutRef.current !== null) {
              window.clearTimeout(returnTimeoutRef.current);
              returnTimeoutRef.current = null;
            }
            void currentWindow
              .destroy()
              .catch((reason) =>
                console.error("Failed to destroy returned PTY window", reason),
              );
          }),
          listenWorkspaceContentWindowEvent("pty-return-failed", (event) => {
            if (
              event.payload.instanceId !== instanceId ||
              event.payload.token !== currentReturnTokenRef.current
            ) {
              return;
            }
            returnAttemptRef.current += 1;
            setError(
              translationRef.current("pty.returnFailed", {
                error: event.payload.message ?? "Unknown error",
              }),
            );
            if (returnTimeoutRef.current !== null) {
              window.clearTimeout(returnTimeoutRef.current);
              returnTimeoutRef.current = null;
            }
            returnInProgressRef.current = false;
            setReturning(false);
            const context = returnHandoffContextRef.current;
            if (context?.transferId === event.payload.token) {
              void rollbackWorkspaceContentHandoff(
                context,
                returnHandoffPayloadRef.current,
                new Error(event.payload.message ?? "返回请求失败"),
              ).catch(() => undefined);
            }
            returnHandoffContextRef.current = null;
            returnHandoffPayloadRef.current = undefined;
          }),
          listenWorkspaceContentWindowEvent(
            "pty-return-drop-requested",
            (event) => {
              if (event.payload.instanceId === instanceId) {
                void requestReturnRef.current(event.payload.targetPaneId);
              }
            },
          ),
        ]);
        if (disposed) {
          registeredListeners.forEach((unlisten) => unlisten());
          return;
        }
        unlisteners.push(...registeredListeners);

        if (handoffStartedRef.current) return;
        handoffStartedRef.current = true;
        const terminal = terminalRef.current;
        if (!terminal) {
          throw new Error(translationRef.current("pty.terminalNotReady"));
        }
        const currentWindow = getCurrentWindow();
        let attachedState: PtySession["state"] | null = null;
        const driverContext: WorkspaceContentHandoffHookContext<"pty"> = {
          content: { kind: "pty", slotId: instanceId },
          source: { kind: "pane", windowLabel: "main", paneId: sourcePaneId },
          target: { kind: "window", windowLabel: currentWindow.label },
          transferId: handoffToken,
          capabilities: {
            prepare: async () => ({ handoff: { token: handoffToken } }),
            attach: async (payload) => {
              attachedState = (
                await terminal.attachHandoff(sessionId, payload.handoff.token)
              ).state;
            },
            rollback: async (payload) => {
              if (payload) await terminal.cancelHandoff(payload.handoff.token);
            },
          },
        };
        const attachedPayload = { handoff: { token: handoffToken } };
        await attachWorkspaceContentHandoff(driverContext, attachedPayload);
        const attachedSession = attachedState;
        if (disposed) return;
        if (
          attachedSession === "exited" ||
          attachedSession === "terminated" ||
          attachedSession === "failed"
        ) {
          closeAfterExitRef.current();
          return;
        }
        await emitWorkspaceContentWindowEvent("main", "pty-detached-ready", {
          instanceId,
          sessionId,
          windowLabel: currentWindow.label,
        });
        if (!disposed) setReady(true);
      } catch (reason) {
        if (!disposed) {
          let status: PtySessionWindowStatus | null = null;
          try {
            status = await getPtySessionWindowStatus(sessionId);
          } catch (statusError) {
            console.warn(
              "Failed to inspect PTY after attach failure",
              statusError,
            );
          }
          if (disposed) return;
          const action = resolveDetachedWindowFailureAction(
            terminalRef.current?.getSessionState(),
            status,
          );
          if (action === "close-ended") {
            closeAfterExitRef.current();
            return;
          }
          if (action === "close-transferred") {
            closeAfterTransferRef.current();
            return;
          }
          setError(formatAppError(reason, t));
          await emitWorkspaceContentWindowEvent("main", "pty-detached-failed", {
            instanceId,
            sessionId,
            windowLabel: currentWindow.label,
            message: formatAppError(reason, t),
          }).catch(() => undefined);
          await currentWindow.destroy().catch(() => undefined);
        }
      }
    };
    void setup();
    return () => {
      disposed = true;
      if (returnTimeoutRef.current !== null) {
        window.clearTimeout(returnTimeoutRef.current);
      }
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [handoffToken, instanceId, sessionId]);

  return (
    <WorkspaceContentWindowShell
      beforeClose={
        tryGetWorkspaceContentAdapter("pty")?.lifecycle?.beforeWindowClose
      }
      onCloseRequested={handleWindowCloseRequest}
      actions={
        <button
          type="button"
          className="ghost-button standalone-pty-return window-titlebar-compact-button"
          disabled={!ready || returning}
          onClick={() => void requestReturnRef.current()}
          title={t("pty.returnToWorkspace")}
        >
          <ArrowLeft size={15} />
          {returning
            ? t("pty.returningToWorkspace")
            : t("pty.returnToWorkspace")}
        </button>
      }
      draggable={ready && !returning}
      onDragStart={(event) => {
        if (!ready || returning) {
          event.preventDefault();
          return;
        }
        event.dataTransfer.effectAllowed = "move";
        const payload = encodeWorkspaceContentDrag({
          kind: "pty",
          contentId: instanceId,
          sourceWindowLabel: getCurrentWindow().label,
        });
        const legacyPayload = encodePtySessionDrag({
          instanceId,
          sourceWindowLabel: getCurrentWindow().label,
        });
        event.dataTransfer.setData(WORKSPACE_CONTENT_DRAG_TYPE, payload);
        event.dataTransfer.setData(PTY_SESSION_DRAG_TYPE, legacyPayload);
        event.dataTransfer.setData("text/plain", payload);
      }}
      title={
        <>
          {ToolIcon ? <ToolIcon size={16} /> : <TerminalIcon size={16} />}
          <strong>{title}</strong>
        </>
      }
    >
      <div className="standalone-pty-content">
        {!ready && !error && (
          <p className="standalone-pty-status">{t("pty.starting")}</p>
        )}
        <PtyTerminal
          ref={terminalRef}
          active
          interactive
          onSessionChange={handleSessionChange}
        />
        {error && <p className="error standalone-pty-error">{error}</p>}
      </div>
    </WorkspaceContentWindowShell>
  );
}

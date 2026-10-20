import { getCurrentWindow } from "@tauri-apps/api/window";
import { ArrowLeft, Terminal as TerminalIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PtySession, ToolKey } from "../lib/tauri";
import {
  formatAppError,
  formatAppErrorState,
  toAppErrorState,
} from "../lib/appErrors";
import { registerAllOrCleanup } from "../lib/workspaceContentListenerSetup";
import { completeDetachedWindowSetup } from "../lib/detachedWindowSetup";
import { TOOLS } from "../lib/tools";
import { PtyTerminal, type PtyTerminalHandle } from "./PtyTerminal";
import { WorkspaceContentWindowShell } from "./WorkspaceContentWindowShell";
import { tryGetWorkspaceContentAdapter } from "./WorkspaceContentView";
import {
  getPtySessionWindowStatus,
  type PtySessionWindowStatus,
} from "../lib/tauri";
import { useDetachedContentWindow } from "../workspace/windows/useDetachedContentWindow";
import { resolveDetachedWindowFailureAction } from "../lib/ptySessionLifecycle";
import {
  sendContentHandoff,
  onContentHandoff,
} from "../lib/workspaceContentWindowProtocol";
import {
  attachWorkspaceContentHandoff,
  prepareWorkspaceContentHandoff,
  rollbackWorkspaceContentHandoff,
  WORKSPACE_CONTENT_WINDOW_HANDOFF_TIMEOUT_MS,
} from "./workspaceContentHandoffRuntime";
import type { WorkspaceContentHandoffHookContext } from "./workspaceContentAdapterRegistry";
import { ptyContentRef } from "../lib/workspaceContentKey";
import { newTransferId } from "../lib/workspaceContentLifecycle";

interface StandalonePtyWindowProps {
  sessionId: string;
  handoffToken: string;
  instanceId: string;
  sourcePaneId: string;
  toolKey?: ToolKey;
  title: string;
}

const RETURN_HANDOFF_TIMEOUT_MS = WORKSPACE_CONTENT_WINDOW_HANDOFF_TIMEOUT_MS;

function isEndedSessionState(state: string | null | undefined) {
  return state === "exited" || state === "terminated" || state === "failed";
}

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
  const returnAttemptRef = useRef(0);
  const currentReturnTokenRef = useRef<string | null>(null);
  const returnHandoffContextRef =
    useRef<WorkspaceContentHandoffHookContext<"pty"> | null>(null);
  const returnHandoffPayloadRef = useRef<
    { handoff: { token: string; sequence?: number } } | undefined
  >(undefined);
  const handoffStartedRef = useRef(false);
  const closeAfterExitRef = useRef<() => void>(() => undefined);
  const closeAfterTransferRef = useRef<() => void>(() => undefined);
  const translationRef = useRef(t);
  translationRef.current = t;
  const windowKit = useDetachedContentWindow("pty", instanceId);
  const {
    returning,
    error,
    setReturning,
    setError,
    isReturning,
    returnTimer,
    destroyWindow,
    createDragStartHandler,
  } = windowKit;
  const [ready, setReady] = useState(false);

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
      if (isReturning()) return;
      const attempt = ++returnAttemptRef.current;
      const isCurrentAttempt = () => returnAttemptRef.current === attempt;
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
      returnTimer.arm(RETURN_HANDOFF_TIMEOUT_MS, () => {
        if (!isCurrentAttempt()) return;
        const timeoutAttempt = ++returnAttemptRef.current;
        if (driverContext) {
          void rollbackWorkspaceContentHandoff(
            driverContext,
            handoffPayload,
            new Error(translationRef.current("pty.returnTimedOut")),
          ).catch(() => undefined);
        }
        void reconcileWindowStatus().then((handled) => {
          if (returnAttemptRef.current !== timeoutAttempt || handled) return;
          setError({
            message: translationRef.current("pty.returnTimedOut"),
            wrapKey: "pty.returnFailed",
          });
          setReturning(false);
        });
      });
      try {
        if (!terminal)
          throw new Error(translationRef.current("pty.terminalNotReady"));
        const currentWindow = getCurrentWindow();
        driverContext = {
          content: ptyContentRef(instanceId),
          source: { kind: "window", windowLabel: currentWindow.label },
          target: {
            kind: "pane",
            windowLabel: "main",
            paneId: targetPaneId ?? sourcePaneId,
          },
          transferId: newTransferId(),
          capabilities: {
            prepare: async () => ({
              handoff: await terminal.captureHandoff("main"),
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
        handoffPayload = prepared.payload;
        returnHandoffContextRef.current = driverContext;
        returnHandoffPayloadRef.current = prepared.payload;
        token = prepared.transferId;
        currentReturnTokenRef.current = prepared.transferId;
        if (!isCurrentAttempt()) {
          await rollbackWorkspaceContentHandoff(
            driverContext,
            prepared.payload,
            new Error(translationRef.current("pty.returnExpired")),
          ).catch(() => undefined);
          return;
        }
        await sendContentHandoff("main", "pty", "return-requested", {
          instanceId,
          sessionId,
          windowLabel: currentWindow.label,
          token: prepared.transferId,
          handoffToken: prepared.payload.handoff.token,
          targetPaneId,
        });
        if (!isCurrentAttempt()) {
          await rollbackWorkspaceContentHandoff(
            driverContext,
            prepared.payload,
            new Error(translationRef.current("pty.returnExpired")),
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
        returnTimer.clear();
        returnAttemptRef.current += 1;
        setError(toAppErrorState(reason, "pty.returnFailed"));
        setReturning(false);
      }
    },
    [instanceId, reconcileWindowStatus, sessionId, sourcePaneId],
  );
  const requestReturnRef = useRef(requestReturn);
  requestReturnRef.current = requestReturn;

  const reportExited = useCallback(
    () =>
      sendContentHandoff("main", "pty", "exited", {
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
      setReturning(false);
      returnTimer.clear();
      if (reportExit) await reportExited();
      await destroyWindow("Failed to destroy detached PTY window");
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
    if (isEndedSessionState(terminalRef.current?.getSessionState())) {
      closeAfterExitRef.current();
      return;
    }
    void requestReturnRef.current();
  }, []);

  const handleCloseBeforeReady = useCallback(() => {
    const currentWindow = getCurrentWindow();
    const terminalState = terminalRef.current?.getSessionState();
    if (isEndedSessionState(terminalState)) {
      closeAfterExitRef.current();
      return;
    }
    if (terminalState !== "running") {
      void getPtySessionWindowStatus(sessionId)
        .then((status) => {
          if (status.state === "ended") {
            closeAfterExitRef.current();
          } else if (status.state === "ownedByAnotherWindow") {
            sendContentHandoff("main", "pty", "failed", {
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
        await completeDetachedWindowSetup({
          registerListeners: () =>
            registerAllOrCleanup([
              onContentHandoff("pty", "return-complete", (event) => {
                if (
                  event.payload.instanceId !== instanceId ||
                  event.payload.token !== currentReturnTokenRef.current
                ) {
                  return;
                }
                returnAttemptRef.current += 1;
                returnHandoffContextRef.current = null;
                returnHandoffPayloadRef.current = undefined;
                returnTimer.clear();
                void destroyWindow("Failed to destroy returned PTY window");
              }),
              onContentHandoff("pty", "return-failed", (event) => {
                if (
                  event.payload.instanceId !== instanceId ||
                  event.payload.token !== currentReturnTokenRef.current
                ) {
                  return;
                }
                returnAttemptRef.current += 1;
                setError({
                  message:
                    event.payload.message ??
                    translationRef.current("pty.returnUnknownError"),
                  wrapKey: "pty.returnFailed",
                });
                returnTimer.clear();
                setReturning(false);
                const context = returnHandoffContextRef.current;
                if (context?.transferId === event.payload.token) {
                  void rollbackWorkspaceContentHandoff(
                    context,
                    returnHandoffPayloadRef.current,
                    new Error(
                      event.payload.message ??
                        translationRef.current("pty.returnRequestFailed"),
                    ),
                  ).catch(() => undefined);
                }
                returnHandoffContextRef.current = null;
                returnHandoffPayloadRef.current = undefined;
              }),
              onContentHandoff("pty", "return-drop-requested", (event) => {
                if (event.payload.instanceId === instanceId) {
                  void requestReturnRef.current(event.payload.targetPaneId);
                }
              }),
            ]),
          isDisposed: () => disposed,
          keepListeners: (registered) => unlisteners.push(...registered),
          afterListeners: async () => {
            if (handoffStartedRef.current) return;
            handoffStartedRef.current = true;
            const terminal = terminalRef.current;
            if (!terminal) {
              throw new Error(translationRef.current("pty.terminalNotReady"));
            }
            const currentWindow = getCurrentWindow();
            let attachedState: PtySession["state"] | null = null;
            const driverContext: WorkspaceContentHandoffHookContext<"pty"> = {
              content: ptyContentRef(instanceId),
              source: {
                kind: "pane",
                windowLabel: "main",
                paneId: sourcePaneId,
              },
              target: { kind: "window", windowLabel: currentWindow.label },
              transferId: newTransferId(),
              capabilities: {
                prepare: async () => ({ handoff: { token: handoffToken } }),
                attach: async (payload) => {
                  attachedState = (
                    await terminal.attachHandoff(
                      sessionId,
                      payload.handoff.token,
                    )
                  ).state;
                },
                rollback: async (payload) => {
                  if (payload)
                    await terminal.cancelHandoff(payload.handoff.token);
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
            await sendContentHandoff("main", "pty", "ready", {
              instanceId,
              sessionId,
              windowLabel: currentWindow.label,
            });
            if (!disposed) setReady(true);
          },
        });
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
          setError(toAppErrorState(reason));
          await sendContentHandoff("main", "pty", "failed", {
            instanceId,
            sessionId,
            windowLabel: currentWindow.label,
            message: formatAppError(reason, translationRef.current),
          }).catch(() => undefined);
          await destroyWindow(
            "Unable to destroy PTY window after handoff failure",
          );
        }
      }
    };
    void setup();
    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [handoffToken, instanceId, sessionId]);

  return (
    <WorkspaceContentWindowShell
      beforeClose={
        tryGetWorkspaceContentAdapter("pty")?.lifecycle?.beforeWindowClose
      }
      isReady={ready}
      onCloseBeforeReady={handleCloseBeforeReady}
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
      onDragStart={createDragStartHandler(() => ready && !returning)}
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
        {error && (
          <p className="error standalone-pty-error">
            {formatAppErrorState(error, t)}
          </p>
        )}
      </div>
    </WorkspaceContentWindowShell>
  );
}

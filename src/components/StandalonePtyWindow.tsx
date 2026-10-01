import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ArrowLeft, Terminal as TerminalIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PtyTerminal, type PtyTerminalHandle } from "./PtyTerminal";
import { useThemeSync } from "../hooks/useThemeSync";
import {
  getPtySessionWindowStatus,
  type PtySessionWindowStatus,
} from "../lib/tauri";
import {
  encodePtySessionDrag,
  PTY_SESSION_DRAG_TYPE,
} from "../lib/ptySessionDrag";
import { resolveDetachedWindowFailureAction } from "../lib/ptySessionLifecycle";

interface StandalonePtyWindowProps {
  sessionId: string;
  handoffToken: string;
  instanceId: string;
  title: string;
}

interface WindowHandoffEvent {
  instanceId: string;
  token: string;
  message?: string;
  targetPaneId?: string;
}

const RETURN_HANDOFF_TIMEOUT_MS = 15_000;

export function StandalonePtyWindow({
  sessionId,
  handoffToken,
  instanceId,
  title,
}: StandalonePtyWindowProps) {
  const { t } = useTranslation();
  const terminalRef = useRef<PtyTerminalHandle>(null);
  const exitHandledRef = useRef(false);
  const returnInProgressRef = useRef(false);
  const returnAttemptRef = useRef(0);
  const currentReturnTokenRef = useRef(handoffToken);
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
  useThemeSync();

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
      setReturning(true);
      setError(null);
      let token: string | null = null;
      const terminal = terminalRef.current;
      returnTimeoutRef.current = window.setTimeout(() => {
        if (!isCurrentAttempt()) return;
        returnTimeoutRef.current = null;
        const timeoutAttempt = ++returnAttemptRef.current;
        if (token) {
          void terminal?.cancelHandoff(token).catch(() => undefined);
        }
        void reconcileWindowStatus().then((handled) => {
          if (returnAttemptRef.current !== timeoutAttempt || handled) return;
          setError(t("pty.returnFailed", { error: "主工作区响应超时" }));
          returnInProgressRef.current = false;
          setReturning(false);
        });
      }, RETURN_HANDOFF_TIMEOUT_MS);
      try {
        const handoff = await terminal?.captureHandoff();
        if (!handoff) throw new Error(t("pty.terminalNotReady"));
        token = handoff.token;
        currentReturnTokenRef.current = handoff.token;
        if (!isCurrentAttempt()) {
          await terminal?.cancelHandoff(handoff.token).catch(() => undefined);
          return;
        }
        await emitTo("main", "pty-return-requested", {
          instanceId,
          sessionId,
          windowLabel: getCurrentWindow().label,
          token: handoff.token,
          targetPaneId,
        });
        if (!isCurrentAttempt()) {
          await terminal?.cancelHandoff(handoff.token).catch(() => undefined);
        }
      } catch (reason) {
        if (token) {
          await terminal?.cancelHandoff(token).catch(() => undefined);
        }
        if (!isCurrentAttempt()) return;
        if (await reconcileWindowStatus()) return;
        if (!isCurrentAttempt()) return;
        if (returnTimeoutRef.current !== null) {
          window.clearTimeout(returnTimeoutRef.current);
          returnTimeoutRef.current = null;
        }
        returnAttemptRef.current += 1;
        setError(t("pty.returnFailed", { error: String(reason) }));
        returnInProgressRef.current = false;
        setReturning(false);
      }
    },
    [instanceId, reconcileWindowStatus, sessionId, t],
  );
  const requestReturnRef = useRef(requestReturn);
  requestReturnRef.current = requestReturn;

  const reportExited = useCallback(
    () =>
      emitTo("main", "pty-detached-exited", {
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

  useEffect(() => {
    const suppressNativeContextMenu = (event: MouseEvent) =>
      event.preventDefault();
    document.addEventListener("contextmenu", suppressNativeContextMenu, true);
    let disposed = false;
    const unlisteners: (() => void)[] = [];
    const setup = async () => {
      const currentWindow = getCurrentWindow();
      try {
        const registeredListeners = await Promise.all([
          currentWindow.onCloseRequested((event) => {
            event.preventDefault();
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
                    emitTo("main", "pty-detached-failed", {
                      instanceId,
                      sessionId,
                      windowLabel: currentWindow.label,
                      message: "独立终端窗口在接管完成前关闭",
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
          }),
          listen<WindowHandoffEvent>("pty-return-complete", (event) => {
            if (event.payload.instanceId !== instanceId) return;
            returnAttemptRef.current += 1;
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
          listen<WindowHandoffEvent>("pty-return-failed", (event) => {
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
            void terminalRef.current
              ?.cancelHandoff(event.payload.token)
              .catch(() => undefined);
          }),
          listen<{ instanceId: string; targetPaneId?: string }>(
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
        const attachedSession = await terminal.attachHandoff(
          sessionId,
          handoffToken,
        );
        if (disposed) return;
        if (
          attachedSession.state === "exited" ||
          attachedSession.state === "terminated" ||
          attachedSession.state === "failed"
        ) {
          closeAfterExitRef.current();
          return;
        }
        await emitTo("main", "pty-detached-ready", {
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
          setError(String(reason));
          await emitTo("main", "pty-detached-failed", {
            instanceId,
            sessionId,
            windowLabel: currentWindow.label,
            message: String(reason),
          }).catch(() => undefined);
          await currentWindow.destroy().catch(() => undefined);
        }
      }
    };
    void setup();
    return () => {
      disposed = true;
      document.removeEventListener(
        "contextmenu",
        suppressNativeContextMenu,
        true,
      );
      if (returnTimeoutRef.current !== null) {
        window.clearTimeout(returnTimeoutRef.current);
      }
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [handoffToken, instanceId, sessionId]);

  return (
    <main className="standalone-pty-window">
      <header className="standalone-pty-header">
        <div
          className="standalone-pty-title"
          draggable={ready && !returning}
          onDragStart={(event) => {
            if (!ready || returning) {
              event.preventDefault();
              return;
            }
            event.dataTransfer.effectAllowed = "move";
            const payload = encodePtySessionDrag({
              instanceId,
              sourceWindowLabel: getCurrentWindow().label,
            });
            event.dataTransfer.setData(PTY_SESSION_DRAG_TYPE, payload);
            event.dataTransfer.setData("text/plain", payload);
          }}
        >
          <TerminalIcon size={16} />
          <strong>{title}</strong>
        </div>
        <button
          type="button"
          className="ghost-button standalone-pty-return"
          disabled={!ready || returning}
          onClick={() => void requestReturnRef.current()}
          title={t("pty.returnToWorkspace")}
        >
          <ArrowLeft size={15} />
          {returning
            ? t("pty.returningToWorkspace")
            : t("pty.returnToWorkspace")}
        </button>
      </header>
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
    </main>
  );
}

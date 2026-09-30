import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ArrowLeft, Terminal as TerminalIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PtyTerminal, type PtyTerminalHandle } from "./PtyTerminal";
import { useThemeSync } from "../hooks/useThemeSync";
import {
  encodePtySessionDrag,
  PTY_SESSION_DRAG_TYPE,
} from "../lib/ptySessionDrag";

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
  const allowCloseRef = useRef(false);
  const returnInProgressRef = useRef(false);
  const returnAttemptRef = useRef(0);
  const currentReturnTokenRef = useRef(handoffToken);
  const returnTimeoutRef = useRef<number | null>(null);
  const handoffStartedRef = useRef(false);
  const translationRef = useRef(t);
  translationRef.current = t;
  const [ready, setReady] = useState(false);
  const [returning, setReturning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useThemeSync();

  const requestReturn = useCallback(
    async (targetPaneId?: string) => {
      if (!ready || returnInProgressRef.current) return;
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
        returnAttemptRef.current += 1;
        if (token) {
          void terminal?.cancelHandoff(token).catch(() => undefined);
        }
        setError(t("pty.returnFailed", { error: "主工作区响应超时" }));
        returnInProgressRef.current = false;
        setReturning(false);
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
    [instanceId, ready, sessionId, t],
  );
  const requestReturnRef = useRef(requestReturn);
  requestReturnRef.current = requestReturn;

  const reportExited = useCallback(
    () =>
      void emitTo("main", "pty-detached-exited", {
        instanceId,
        sessionId,
        windowLabel: getCurrentWindow().label,
      }).catch(() => undefined),
    [instanceId, sessionId],
  );

  const handleSessionChange = useCallback(
    (session: { state: string } | null) => {
      if (session?.state !== "exited" && session?.state !== "terminated")
        return;
      reportExited();
      window.setTimeout(() => {
        allowCloseRef.current = true;
        void getCurrentWindow().close();
      }, 250);
    },
    [reportExited],
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
            if (allowCloseRef.current) return;
            event.preventDefault();
            void requestReturnRef.current();
          }),
          listen<WindowHandoffEvent>("pty-return-complete", (event) => {
            if (event.payload.instanceId !== instanceId) return;
            returnAttemptRef.current += 1;
            if (returnTimeoutRef.current !== null) {
              window.clearTimeout(returnTimeoutRef.current);
              returnTimeoutRef.current = null;
            }
            allowCloseRef.current = true;
            void currentWindow.close();
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
        await terminal.attachHandoff(sessionId, handoffToken);
        if (disposed) return;
        await emitTo("main", "pty-detached-ready", {
          instanceId,
          sessionId,
          windowLabel: currentWindow.label,
        });
        if (!disposed) setReady(true);
      } catch (reason) {
        if (!disposed) {
          setError(String(reason));
          await emitTo("main", "pty-detached-failed", {
            instanceId,
            sessionId,
            windowLabel: currentWindow.label,
            message: String(reason),
          }).catch(() => undefined);
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

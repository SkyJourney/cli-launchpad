import { Channel } from "@tauri-apps/api/core";
import {
  readText as readClipboardText,
  writeText as writeClipboardText,
} from "@tauri-apps/plugin-clipboard-manager";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/xterm";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  acknowledgePtyOutput,
  beginPtyHandoff,
  cancelPtyHandoff,
  completePtyHandoff,
  createPtySession,
  finalizePtyHandoff,
  resizePtySession,
  reportPtyFrontendStage,
  stagePtyHandoffSnapshot,
  terminatePtySession,
  writePtySession,
  type PtyHandoff,
  type PtyEvent,
  type PtyFrontendStage,
  type PtySession,
  type PtySizeUpdate,
  type PtyTerminalSnapshot,
  type ToolKey,
} from "../lib/tauri";
import {
  applyPendingPtyExit,
  canTerminatePtySession,
} from "../lib/ptySessionLifecycle";
import "@xterm/xterm/css/xterm.css";

const MAX_PTY_COLUMNS = 500;
const MAX_PTY_ROWS = 300;

export interface PtyTerminalHandle {
  startSession(
    directoryId: number,
    toolKey: ToolKey,
    resumeSessionId?: string,
  ): Promise<void>;
  closeSession(confirm?: boolean): Promise<PtySessionCloseResult>;
  captureHandoff(): Promise<PtyHandoff>;
  cancelHandoff(token: string): Promise<void>;
  attachHandoff(sessionId: string, token: string): Promise<PtySession>;
  getSessionState(): PtySession["state"] | null;
}

export type PtySessionCloseResult =
  | "closed"
  | "terminating"
  | "cancelled"
  | "pending";

interface PtyTerminalProps {
  active?: boolean;
  visible?: boolean;
  interactive?: boolean;
  onFocus?: () => void;
  onSessionChange?: (session: PtySession | null) => void;
}

export const PtyTerminal = forwardRef<PtyTerminalHandle, PtyTerminalProps>(
  function PtyTerminal(
    {
      active = true,
      visible = active,
      interactive = true,
      onFocus,
      onSessionChange,
    },
    ref,
  ) {
    const { t } = useTranslation();
    const hostRef = useRef<HTMLDivElement>(null);
    const terminalRef = useRef<Terminal | null>(null);
    const fitRef = useRef<FitAddon | null>(null);
    const serializeRef = useRef<SerializeAddon | null>(null);
    const sessionRef = useRef<PtySession | null>(null);
    const interactiveRef = useRef(interactive);
    const paneInteractiveRef = useRef(interactive);
    const visibleRef = useRef(visible);
    const onFocusRef = useRef(onFocus);
    const scheduleSendSizeRef = useRef<(() => void) | null>(null);
    const handoffInProgressRef = useRef(false);
    const lastWrittenSequenceRef = useRef(0);
    const sequenceWaitersRef = useRef<
      Array<{
        sequence: number;
        resolve: () => void;
        reject: (reason: Error) => void;
        timer: number;
      }>
    >([]);
    const snapshotWaiterRef = useRef<{
      resolve: () => void;
      reject: (reason: Error) => void;
      timer: number;
    } | null>(null);
    const lastSentSizeRef = useRef<{ cols: number; rows: number } | null>(null);
    const onSessionChangeRef = useRef(onSessionChange);
    const startingRef = useRef(false);
    const pendingInputRef = useRef<string[]>([]);
    const reportedFrontendStagesRef = useRef(new Set<string>());
    const pendingExitRef = useRef(
      new Map<string, Extract<PtyEvent, { type: "exited" }>>(),
    );
    const closingSessionRef = useRef<string | null>(null);
    const [session, setSession] = useState<PtySession | null>(null);
    const [starting, setStarting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [handoffInProgress, setHandoffInProgress] = useState(false);

    interactiveRef.current = interactive && !handoffInProgressRef.current;
    paneInteractiveRef.current = interactive;
    visibleRef.current = visible;
    onFocusRef.current = onFocus;

    onSessionChangeRef.current = onSessionChange;

    const markSequenceWritten = (sequence: number) => {
      lastWrittenSequenceRef.current = Math.max(
        lastWrittenSequenceRef.current,
        sequence,
      );
      const remaining: typeof sequenceWaitersRef.current = [];
      for (const waiter of sequenceWaitersRef.current) {
        if (waiter.sequence <= lastWrittenSequenceRef.current) {
          window.clearTimeout(waiter.timer);
          waiter.resolve();
        } else {
          remaining.push(waiter);
        }
      }
      sequenceWaitersRef.current = remaining;
    };

    const waitForWrittenSequence = (sequence: number) => {
      if (lastWrittenSequenceRef.current >= sequence) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          sequenceWaitersRef.current = sequenceWaitersRef.current.filter(
            (waiter) => waiter.resolve !== resolve,
          );
          reject(new Error(t("pty.handoffOutputTimeout")));
        }, 8_000);
        sequenceWaitersRef.current.push({ sequence, resolve, reject, timer });
      });
    };

    const setHandoffBusy = (busy: boolean) => {
      handoffInProgressRef.current = busy;
      interactiveRef.current = paneInteractiveRef.current && !busy;
      setHandoffInProgress(busy);
    };

    useEffect(() => {
      const host = hostRef.current;
      if (!host) return;

      const terminal = new Terminal({
        cursorBlink: false,
        cursorInactiveStyle: "none",
        fontFamily: '"Maple Mono NF CN", monospace',
        fontSize: 13,
        scrollback: 5000,
        theme: {
          background: "#101318",
          foreground: "#e6e8eb",
          cursor: "#e6e8eb",
          selectionBackground: "#54627580",
        },
      });
      const fit = new FitAddon();
      const serialize = new SerializeAddon();
      terminal.loadAddon(fit);
      terminal.loadAddon(serialize);
      terminal.open(host);
      terminalRef.current = terminal;
      fitRef.current = fit;
      serializeRef.current = serialize;

      const sendSize = () => {
        if (!host.clientWidth || !host.clientHeight) return;
        try {
          fitTerminalToPtyBounds(fit, terminal);
          const active = sessionRef.current;
          if (
            visibleRef.current &&
            active?.state === "running" &&
            terminal.cols > 0 &&
            terminal.rows > 0
          ) {
            const nextSize = sizeOf(terminal);
            const previousSize = lastSentSizeRef.current;
            if (
              previousSize?.cols !== nextSize.cols ||
              previousSize?.rows !== nextSize.rows
            ) {
              lastSentSizeRef.current = nextSize;
              console.info("PTY frontend resize requested", {
                sessionId: active.sessionId,
                cols: nextSize.cols,
                rows: nextSize.rows,
              });
              void resizePtySession(active.sessionId, nextSize).catch(
                (reason) => setError(String(reason)),
              );
            }
          }
        } catch (reason) {
          setError(String(reason));
        }
      };
      let resizeFrame = 0;
      const observer = new ResizeObserver(() => {
        cancelAnimationFrame(resizeFrame);
        resizeFrame = requestAnimationFrame(sendSize);
      });
      scheduleSendSizeRef.current = () => {
        cancelAnimationFrame(resizeFrame);
        resizeFrame = requestAnimationFrame(sendSize);
      };
      observer.observe(host);
      sendSize();

      const input = terminal.onData((data) => {
        const active = sessionRef.current;
        if (interactiveRef.current && active?.state === "running") {
          void writePtySession(active.sessionId, data).catch((reason) =>
            setError(String(reason)),
          );
        } else if (startingRef.current) {
          // ConPTY can ask xterm for its cursor position before create_pty_session
          // resolves. Preserve xterm's reply until the new session id is known.
          pendingInputRef.current.push(data);
        }
      });

      const isMac = /Macintosh|Mac OS X/i.test(navigator.userAgent);
      const isWindows = /Windows/i.test(navigator.userAgent);
      terminal.attachCustomKeyEventHandler((event) => {
        if (!interactiveRef.current) return false;
        if (event.type !== "keydown" || event.isComposing) return true;

        const key = event.key.toLowerCase();
        const control = event.ctrlKey && !event.altKey && !event.metaKey;
        const command = event.metaKey && !event.ctrlKey && !event.altKey;
        const copyText = isMac
          ? command && !event.shiftKey && key === "c"
          : control && event.shiftKey && key === "c";
        const pasteText = isMac
          ? command && !event.shiftKey && key === "v"
          : control && event.shiftKey && key === "v";
        const active = sessionRef.current;

        if (copyText) {
          event.preventDefault();
          const selectedText = terminal.getSelection();
          if (selectedText) {
            void writeClipboardText(selectedText).catch((reason) =>
              setError(String(reason)),
            );
          }
          return false;
        }

        const pasteTextFromClipboard = () => {
          event.preventDefault();
          if (active?.state === "running") {
            void readClipboardText()
              .then((text) => {
                if (text) terminal.paste(text);
              })
              .catch((reason) => {
                if (!isClipboardTextUnavailable(reason)) {
                  setError(String(reason));
                }
              });
          }
          return false;
        };

        if (pasteText) return pasteTextFromClipboard();

        const controlV = control && !event.shiftKey && key === "v";
        const altV =
          event.altKey && !event.ctrlKey && !event.metaKey && key === "v";
        if (active?.state === "running") {
          if (active.toolKey === "claude" && isWindows && altV) {
            event.preventDefault();
            void writePtySession(active.sessionId, "\u001bv").catch((reason) =>
              setError(String(reason)),
            );
            return false;
          }
          if (
            (active.toolKey === "codex" ||
              (active.toolKey === "claude" && !isWindows)) &&
            controlV
          ) {
            event.preventDefault();
            void writePtySession(active.sessionId, "\u0016").catch((reason) =>
              setError(String(reason)),
            );
            return false;
          }
          if (
            controlV &&
            ((active.toolKey === "claude" && isWindows) ||
              active.toolKey === "antigravity")
          ) {
            return pasteTextFromClipboard();
          }
        }

        return true;
      });

      return () => {
        cancelAnimationFrame(resizeFrame);
        scheduleSendSizeRef.current = null;
        observer.disconnect();
        input.dispose();
        terminal.dispose();
        terminalRef.current = null;
        fitRef.current = null;
        serializeRef.current = null;
        for (const waiter of sequenceWaitersRef.current) {
          window.clearTimeout(waiter.timer);
          waiter.reject(new Error("PTY terminal was disposed"));
        }
        sequenceWaitersRef.current = [];
      };
    }, []);

    useEffect(() => {
      if (!visible) return;
      const frame = requestAnimationFrame(() => {
        scheduleSendSizeRef.current?.();
      });
      return () => cancelAnimationFrame(frame);
    }, [visible]);

    useEffect(() => {
      const terminal = terminalRef.current;
      if (!terminal) return;
      const running = session?.state === "running";
      terminal.options.cursorBlink = running;
      terminal.options.cursorInactiveStyle = running ? "outline" : "none";
      if (running && active && interactive) terminal.focus();
      else terminal.blur();
    }, [active, interactive, handoffInProgress, session?.state]);

    const updateSession = (
      next:
        | PtySession
        | null
        | ((current: PtySession | null) => PtySession | null),
    ) => {
      const resolved =
        typeof next === "function" ? next(sessionRef.current) : next;
      sessionRef.current = resolved;
      setSession(resolved);
      onSessionChangeRef.current?.(resolved);
    };

    const reportFrontendStageOnce = (
      sessionId: string,
      stage: PtyFrontendStage,
    ): boolean => {
      const key = `${sessionId}:${stage}`;
      if (reportedFrontendStagesRef.current.has(key)) return false;
      reportedFrontendStagesRef.current.add(key);
      void reportPtyFrontendStage(sessionId, stage).catch(() => {});
      return true;
    };

    const bindChannel = (channel: Channel<PtyEvent>) => {
      channel.onmessage = (event) => {
        const terminal = terminalRef.current;
        if (!terminal) return;
        if (event.type === "snapshot") {
          terminal.reset();
          terminal.resize(event.cols, event.rows);
          terminal.write(event.data, () => {
            markSequenceWritten(event.sequence);
            snapshotWaiterRef.current?.resolve();
          });
          return;
        }
        handlePtyEvent(
          event,
          terminal,
          updateSession,
          setError,
          pendingExitRef.current,
          reportFrontendStageOnce,
          hostRef.current,
          (sessionId) => {
            if (closingSessionRef.current === sessionId) {
              closingSessionRef.current = null;
            }
          },
          markSequenceWritten,
        );
      };
    };

    const closeSession = useCallback(
      async (confirm = true): Promise<PtySessionCloseResult> => {
        if (startingRef.current) return "pending";
        const currentSession = sessionRef.current;
        if (!currentSession || currentSession.state !== "running") {
          return "closed";
        }
        if (
          !canTerminatePtySession(
            currentSession.state,
            handoffInProgressRef.current,
          )
        ) {
          return "cancelled";
        }
        if (closingSessionRef.current === currentSession.sessionId) {
          return "terminating";
        }
        if (confirm && !window.confirm(t("pty.confirmClose")))
          return "cancelled";

        setError(null);
        closingSessionRef.current = currentSession.sessionId;
        try {
          await terminatePtySession(currentSession.sessionId);
          return "terminating";
        } catch (reason) {
          closingSessionRef.current = null;
          setError(String(reason));
          return "cancelled";
        }
      },
      [t],
    );

    useImperativeHandle(
      ref,
      () => ({
        closeSession,
        getSessionState() {
          return sessionRef.current?.state ?? null;
        },
        async startSession(directoryId, toolKey, resumeSessionId) {
          const terminal = terminalRef.current;
          if (!terminal) {
            setError(t("pty.terminalNotReady"));
            return;
          }
          if (sessionRef.current?.state === "running" || startingRef.current)
            return;

          startingRef.current = true;
          setStarting(true);
          setError(null);
          pendingInputRef.current = [];
          lastSentSizeRef.current = null;
          reportedFrontendStagesRef.current.clear();
          lastWrittenSequenceRef.current = 0;
          terminal.reset();
          try {
            if (fitRef.current)
              fitTerminalToPtyBounds(fitRef.current, terminal);
            const initialSize = sizeOf(terminal);
            lastSentSizeRef.current = initialSize;
            const channel = new Channel<PtyEvent>();
            bindChannel(channel);
            const created = await createPtySession(
              directoryId,
              toolKey,
              initialSize,
              channel,
              resumeSessionId,
            );
            const earlyExit = pendingExitRef.current.get(created.sessionId);
            pendingExitRef.current.delete(created.sessionId);
            const startupInput = pendingInputRef.current.splice(0).join("");
            const resolvedSession = applyPendingPtyExit(created, earlyExit);
            updateSession(resolvedSession);
            if (startupInput && !earlyExit && created.state === "running") {
              await writePtySession(created.sessionId, startupInput);
              reportFrontendStageOnce(created.sessionId, "startupInputFlushed");
            }
          } catch (reason) {
            pendingInputRef.current = [];
            lastSentSizeRef.current = null;
            setError(String(reason));
          } finally {
            startingRef.current = false;
            setStarting(false);
          }
        },
        async captureHandoff() {
          const currentSession = sessionRef.current;
          const terminal = terminalRef.current;
          const serialize = serializeRef.current;
          if (
            !currentSession ||
            currentSession.state !== "running" ||
            !terminal ||
            !serialize
          ) {
            throw new Error(t("pty.terminalNotReady"));
          }
          if (handoffInProgressRef.current) {
            throw new Error(t("pty.handoffInProgress"));
          }

          setError(null);
          setHandoffBusy(true);
          let handoff: PtyHandoff | null = null;
          try {
            handoff = await beginPtyHandoff(currentSession.sessionId);
            await waitForWrittenSequence(handoff.sequence);
            const snapshot: PtyTerminalSnapshot = {
              data: serialize.serialize(),
              cols: terminal.cols,
              rows: terminal.rows,
            };
            await stagePtyHandoffSnapshot(
              currentSession.sessionId,
              handoff.token,
              handoff.sequence,
              snapshot,
            );
            return handoff;
          } catch (reason) {
            if (handoff) {
              await cancelPtyHandoff(
                currentSession.sessionId,
                handoff.token,
              ).catch(() => undefined);
            }
            setHandoffBusy(false);
            setError(String(reason));
            throw reason;
          }
        },
        async cancelHandoff(token) {
          const currentSession = sessionRef.current;
          try {
            if (currentSession) {
              await cancelPtyHandoff(currentSession.sessionId, token);
            }
          } finally {
            setHandoffBusy(false);
          }
        },
        async attachHandoff(sessionId, token) {
          const terminal = terminalRef.current;
          if (!terminal) {
            throw new Error(t("pty.terminalNotReady"));
          }
          setHandoffBusy(true);
          setError(null);
          const channel = new Channel<PtyEvent>();
          const snapshotReady = new Promise<void>((resolve, reject) => {
            const timer = window.setTimeout(() => {
              snapshotWaiterRef.current = null;
              reject(new Error(t("pty.handoffSnapshotTimeout")));
            }, 8_000);
            snapshotWaiterRef.current = {
              resolve: () => {
                window.clearTimeout(timer);
                snapshotWaiterRef.current = null;
                resolve();
              },
              reject: (reason) => {
                window.clearTimeout(timer);
                snapshotWaiterRef.current = null;
                reject(reason);
              },
              timer,
            };
          });
          void snapshotReady.catch(() => undefined);
          bindChannel(channel);
          try {
            await completePtyHandoff(sessionId, token, channel);
            await snapshotReady;
            if (hostRef.current?.clientWidth && hostRef.current.clientHeight) {
              if (fitRef.current) {
                fitTerminalToPtyBounds(fitRef.current, terminal);
              }
            }
            const nextSize = sizeOf(terminal);
            const finalized = await finalizePtyHandoff(
              sessionId,
              token,
              nextSize,
            );
            lastSentSizeRef.current = nextSize;
            const earlyExit = pendingExitRef.current.get(sessionId);
            pendingExitRef.current.delete(sessionId);
            const resolvedSession = applyPendingPtyExit(finalized, earlyExit);
            updateSession(resolvedSession);
            setHandoffBusy(false);
            return resolvedSession;
          } catch (reason) {
            snapshotWaiterRef.current?.reject(new Error(String(reason)));
            setHandoffBusy(false);
            setError(String(reason));
            throw reason;
          }
        },
      }),
      [closeSession, starting, t],
    );

    return (
      <section className="pty-panel" aria-label={t("pty.panelLabel")}>
        <div className="pty-terminal-wrap">
          {!session && !starting && (
            <div className="pty-empty">{t("pty.empty")}</div>
          )}
          {starting && <div className="pty-empty">{t("pty.starting")}</div>}
          <div
            ref={hostRef}
            className={`pty-terminal-host${session?.state === "running" ? "" : " pty-terminal-idle"}`}
            onPointerDown={() => onFocusRef.current?.()}
          />
        </div>
        {error && <p className="error pty-error">{error}</p>}
      </section>
    );
  },
);

function sizeOf(terminal: Terminal): PtySizeUpdate {
  return {
    cols: Math.max(1, terminal.cols),
    rows: Math.max(1, terminal.rows),
    pixelWidth: 0,
    pixelHeight: 0,
  };
}

function fitTerminalToPtyBounds(fit: FitAddon, terminal: Terminal) {
  fit.fit();
  const cols = Math.min(MAX_PTY_COLUMNS, Math.max(1, terminal.cols));
  const rows = Math.min(MAX_PTY_ROWS, Math.max(1, terminal.rows));
  if (cols !== terminal.cols || rows !== terminal.rows) {
    terminal.resize(cols, rows);
  }
}

function isClipboardTextUnavailable(reason: unknown): boolean {
  const message = String(reason).toLowerCase();
  return (
    message.includes("clipboard") &&
    (message.includes("empty") ||
      message.includes("not available in the requested format"))
  );
}

function handlePtyEvent(
  event: PtyEvent,
  terminal: Terminal,
  updateSession: (
    session:
      | PtySession
      | null
      | ((current: PtySession | null) => PtySession | null),
  ) => void,
  setError: (message: string | null) => void,
  pendingExit: Map<string, Extract<PtyEvent, { type: "exited" }>>,
  reportFrontendStage: (sessionId: string, stage: PtyFrontendStage) => boolean,
  host: HTMLDivElement | null,
  onExited: (sessionId: string) => void,
  onOutputProcessed: (sequence: number) => void,
) {
  if (event.type === "snapshot") return;
  if (event.type === "output") {
    const isFirstOutput = reportFrontendStage(
      event.sessionId,
      "outputReceived",
    );
    const pendingTimer = isFirstOutput
      ? window.setTimeout(() => {
          reportFrontendStage(event.sessionId, "xtermWritePending");
          resumeVisibleXtermRenderer(
            terminal,
            host,
            event.sessionId,
            reportFrontendStage,
          );
        }, 2000)
      : undefined;
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(atob(event.dataBase64), (character) =>
        character.charCodeAt(0),
      );
    } catch (reason) {
      if (pendingTimer !== undefined) window.clearTimeout(pendingTimer);
      reportFrontendStage(event.sessionId, "outputDecodeFailed");
      setError(String(reason));
      return;
    }

    try {
      resumeVisibleXtermRenderer(
        terminal,
        host,
        event.sessionId,
        reportFrontendStage,
      );
      terminal.write(bytes, () => {
        if (pendingTimer !== undefined) window.clearTimeout(pendingTimer);
        if (isFirstOutput) {
          reportFrontendStage(event.sessionId, "xtermWriteCompleted");
        }
        void acknowledgePtyOutput(event.sessionId, event.sequence)
          .then(() => onOutputProcessed(event.sequence))
          .catch((reason) => setError(String(reason)));
      });
    } catch (reason) {
      if (pendingTimer !== undefined) window.clearTimeout(pendingTimer);
      reportFrontendStage(event.sessionId, "xtermWriteFailed");
      setError(String(reason));
    }
  } else if (event.type === "exited") {
    onExited(event.sessionId);
    // The process can exit before create_pty_session returns its metadata.
    // Keep that event until the returned session id is installed.
    updateSession((current) =>
      current?.sessionId === event.sessionId
        ? { ...current, state: event.state, exitCode: event.exitCode }
        : (() => {
            pendingExit.set(event.sessionId, event);
            return current;
          })(),
    );
  } else {
    setError(event.message);
  }
}

function resumeVisibleXtermRenderer(
  terminal: Terminal,
  host: HTMLDivElement | null,
  sessionId: string,
  reportFrontendStage: (sessionId: string, stage: PtyFrontendStage) => boolean,
) {
  if (!host?.isConnected || host.clientWidth <= 0 || host.clientHeight <= 0) {
    return;
  }

  // xterm 5.5 stores this service directly on Terminal. WebView2 can leave its
  // IntersectionObserver pause latched for a visible pane, so recover only when
  // the host has real on-screen geometry and the renderer reports itself paused.
  const renderService = (
    terminal as unknown as {
      _renderService?: {
        _isPaused?: boolean;
        _pausedResizeTask?: { flush?: () => void };
      };
    }
  )._renderService;
  if (!renderService?._isPaused) return;

  reportFrontendStage(sessionId, "rendererPaused");
  try {
    renderService._isPaused = false;
    renderService._pausedResizeTask?.flush?.();
    terminal.refresh(0, Math.max(0, terminal.rows - 1));
    reportFrontendStage(sessionId, "rendererResumed");
  } catch {
    // The probe is best-effort and guarded for xterm internal API changes.
  }
}

import { Channel } from "@tauri-apps/api/core";
import {
  readText as readClipboardText,
  writeText as writeClipboardText,
} from "@tauri-apps/plugin-clipboard-manager";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import {
  acknowledgePtyOutput,
  createPtySession,
  resizePtySession,
  reportPtyFrontendStage,
  terminatePtySession,
  writePtySession,
  type PtyEvent,
  type PtyFrontendStage,
  type PtySession,
  type PtySizeUpdate,
  type ToolKey,
} from "../lib/tauri";
import { TOOLS } from "../lib/tools";
import "@xterm/xterm/css/xterm.css";

const MAX_PTY_COLUMNS = 500;
const MAX_PTY_ROWS = 300;

export interface PtyTerminalHandle {
  startSession(
    directoryId: number,
    toolKey: ToolKey,
    resumeSessionId?: string,
  ): Promise<void>;
}

interface PtyTerminalProps {
  onSessionChange?: (session: PtySession | null) => void;
}

export const PtyTerminal = forwardRef<PtyTerminalHandle, PtyTerminalProps>(
  function PtyTerminal({ onSessionChange }, ref) {
    const { t } = useTranslation();
    const hostRef = useRef<HTMLDivElement>(null);
    const terminalRef = useRef<Terminal | null>(null);
    const fitRef = useRef<FitAddon | null>(null);
    const sessionRef = useRef<PtySession | null>(null);
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
    const [closingSessionId, setClosingSessionId] = useState<string | null>(
      null,
    );
    const [error, setError] = useState<string | null>(null);

    onSessionChangeRef.current = onSessionChange;

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
      terminal.loadAddon(fit);
      terminal.open(host);
      terminalRef.current = terminal;
      fitRef.current = fit;

      const sendSize = () => {
        if (!host.clientWidth || !host.clientHeight) return;
        try {
          fitTerminalToPtyBounds(fit, terminal);
          const active = sessionRef.current;
          if (
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
      observer.observe(host);
      sendSize();

      const input = terminal.onData((data) => {
        const active = sessionRef.current;
        if (active?.state === "running") {
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
        observer.disconnect();
        input.dispose();
        terminal.dispose();
        terminalRef.current = null;
        fitRef.current = null;
      };
    }, []);

    useEffect(() => {
      const terminal = terminalRef.current;
      if (!terminal) return;
      const running = session?.state === "running";
      terminal.options.cursorBlink = running;
      terminal.options.cursorInactiveStyle = running ? "outline" : "none";
      if (!running) terminal.blur();
    }, [session?.state]);

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

    useImperativeHandle(
      ref,
      () => ({
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
          terminal.reset();
          try {
            if (fitRef.current)
              fitTerminalToPtyBounds(fitRef.current, terminal);
            const initialSize = sizeOf(terminal);
            lastSentSizeRef.current = initialSize;
            const channel = new Channel<PtyEvent>();
            channel.onmessage = (event) =>
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
                    setClosingSessionId(null);
                  }
                },
              );
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
            updateSession(
              earlyExit
                ? {
                    ...created,
                    state: earlyExit.state,
                    exitCode: earlyExit.exitCode,
                  }
                : created,
            );
            if (startupInput && !earlyExit && created.state === "running") {
              await writePtySession(created.sessionId, startupInput);
              reportFrontendStageOnce(created.sessionId, "startupInputFlushed");
            }
            terminal.focus();
          } catch (reason) {
            pendingInputRef.current = [];
            lastSentSizeRef.current = null;
            setError(String(reason));
          } finally {
            startingRef.current = false;
            setStarting(false);
          }
        },
      }),
      [starting, t],
    );

    const closeSession = async () => {
      if (!session || session.state !== "running") return;
      if (!window.confirm(t("pty.confirmClose"))) return;
      setError(null);
      closingSessionRef.current = session.sessionId;
      setClosingSessionId(session.sessionId);
      try {
        await terminatePtySession(session.sessionId);
      } catch (reason) {
        closingSessionRef.current = null;
        setClosingSessionId(null);
        setError(String(reason));
      }
    };

    const toolName = session
      ? TOOLS.find((tool) => tool.key === session.toolKey)?.label
      : null;

    return (
      <section className="pty-panel" aria-label={t("pty.panelLabel")}>
        {session && (
          <header className="pty-panel-head">
            <div className="pty-panel-title">
              <strong>{toolName}</strong>
              <span className={`pty-state pty-state-${session.state}`}>
                {t(`pty.status.${session.state}`)}
              </span>
            </div>
            {session.state === "running" && (
              <button
                className="icon-button"
                aria-label={t("pty.close")}
                title={t("pty.close")}
                disabled={closingSessionId === session.sessionId}
                onClick={() => void closeSession()}
              >
                <X size={15} />
              </button>
            )}
          </header>
        )}
        <div className="pty-terminal-wrap">
          {!session && !starting && (
            <div className="pty-empty">{t("pty.empty")}</div>
          )}
          {starting && <div className="pty-empty">{t("pty.starting")}</div>}
          <div
            ref={hostRef}
            className={`pty-terminal-host${session?.state === "running" ? "" : " pty-terminal-idle"}`}
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
) {
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
        void acknowledgePtyOutput(event.sessionId, event.sequence).catch(
          (reason) => setError(String(reason)),
        );
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

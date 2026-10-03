import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import {
  acknowledgePtyOutput,
  type PtyEvent,
  type PtyFrontendStage,
  type PtySession,
} from "./tauri";

const MAX_PTY_COLUMNS = 500;
const MAX_PTY_ROWS = 300;

export function fitTerminalToPtyBounds(fit: FitAddon, terminal: Terminal) {
  // The terminal scrollbar is hidden in CSS, so FitAddon must not reserve its
  // fallback scrollbar width when the browser reports no native scrollbar.
  const viewport = (
    terminal as unknown as {
      _core?: { viewport?: { scrollBarWidth: number } };
    }
  )._core?.viewport;
  if (viewport) {
    viewport.scrollBarWidth = 0;
  }
  fit.fit();
  const cols = Math.min(MAX_PTY_COLUMNS, Math.max(1, terminal.cols));
  const rows = Math.min(MAX_PTY_ROWS, Math.max(1, terminal.rows));
  if (cols !== terminal.cols || rows !== terminal.rows) {
    terminal.resize(cols, rows);
  }
}

export function isClipboardTextUnavailable(reason: unknown): boolean {
  const message = String(reason).toLowerCase();
  return (
    message.includes("clipboard") &&
    (message.includes("empty") ||
      message.includes("not available in the requested format"))
  );
}

export function handlePtyEvent(
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

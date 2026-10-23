import { Component, type ErrorInfo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { WindowTitlebar } from "./WindowTitlebar";

interface AppErrorBoundaryProps {
  children: ReactNode;
  /** Test seam only; the default reloads the whole window. */
  onReload?: () => void;
}

interface AppErrorBoundaryState {
  failed: boolean;
}

function reloadWindow() {
  window.location.reload();
}

export class AppErrorBoundary extends Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("[app.render_crashed]", error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <AppCrashFallback onReload={this.props.onReload ?? reloadWindow} />;
  }
}

/** Renders nothing if the title bar itself fails, so the fallback keeps its reload button. */
class TitlebarGuard extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("[app.crash_titlebar_failed]", error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function AppCrashFallback({ onReload }: { onReload: () => void }) {
  const { t } = useTranslation();
  // The main window has no native title bar (decorations: false), so the fallback brings a
  // minimal one: without it the window could not be dragged, minimized or closed.
  return (
    <div className="app-crash-shell">
      <TitlebarGuard>
        <WindowTitlebar variant="standalone" />
      </TitlebarGuard>
      <main className="app-crash" role="alert">
        <h1>{t("appCrash.title")}</h1>
        <p>{t("appCrash.description")}</p>
        <button type="button" className="pty-layout-action" onClick={onReload}>
          {t("appCrash.reload")}
        </button>
      </main>
    </div>
  );
}

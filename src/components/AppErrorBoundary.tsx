import { Component, type ErrorInfo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

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

function AppCrashFallback({ onReload }: { onReload: () => void }) {
  const { t } = useTranslation();
  return (
    <main className="app-crash" role="alert">
      <h1>{t("appCrash.title")}</h1>
      <p>{t("appCrash.description")}</p>
      <button type="button" className="pty-layout-action" onClick={onReload}>
        {t("appCrash.reload")}
      </button>
    </main>
  );
}

import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Square, X } from "lucide-react";
import type { CSSProperties, MouseEvent, ReactNode } from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { getWindowChromePolicy } from "../lib/windowChrome";
import { formatAppError } from "../lib/appErrors";

interface WindowTitlebarProps {
  variant: "main" | "standalone";
  leading?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}

const windowChrome = getWindowChromePolicy(navigator.userAgent);
const titlebarStyle = {
  "--window-chrome-traffic-light-inset": `${windowChrome.trafficLightInset}px`,
} as CSSProperties;

export function WindowTitlebar({
  variant,
  leading,
  children,
  actions,
}: WindowTitlebarProps) {
  const { t } = useTranslation();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let disposed = false;
    const updateMaximized = () => {
      void appWindow
        .isMaximized()
        .then((value) => {
          if (!disposed) setMaximized(value);
        })
        .catch((error) => console.warn("Unable to read window state", error));
    };
    const unlisteners: (() => void)[] = [];
    updateMaximized();
    void appWindow
      .onResized(updateMaximized)
      .then((unlisten) => {
        if (disposed) unlisten();
        else unlisteners.push(unlisten);
      })
      .catch((error) => console.warn("Unable to watch window size", error));
    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, []);

  const runWindowAction = (action: () => Promise<unknown>) => {
    void action().catch((error) => toast.error(formatAppError(error, t)));
  };

  const toggleMaximized = () => {
    runWindowAction(() => getCurrentWindow().toggleMaximize());
  };

  const isWindowDragSurface = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof Element)) return false;
    return (
      (target === event.currentTarget &&
        event.currentTarget.classList.contains(
          "window-titlebar-drag-region",
        )) ||
      target.closest("[data-window-drag-handle]") !== null
    );
  };

  const onDragSurfaceMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.detail > 1 || !isWindowDragSurface(event))
      return;
    runWindowAction(() => getCurrentWindow().startDragging());
  };

  const onDragSurfaceDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!isWindowDragSurface(event)) return;
    event.preventDefault();
    toggleMaximized();
  };

  return (
    <header
      className={`window-titlebar window-titlebar-${variant}${windowChrome.hasNativeWindowControls ? " window-titlebar-macos" : ""}`}
      style={titlebarStyle}
      aria-label={t("windowChrome.titlebar")}
    >
      <div
        className="window-titlebar-leading"
        onMouseDown={onDragSurfaceMouseDown}
        onDoubleClick={onDragSurfaceDoubleClick}
      >
        {leading}
        {children}
      </div>
      <div
        className="window-titlebar-drag-region"
        aria-hidden="true"
        onMouseDown={onDragSurfaceMouseDown}
        onDoubleClick={onDragSurfaceDoubleClick}
      />
      {actions && <div className="window-titlebar-actions">{actions}</div>}
      {!windowChrome.hasNativeWindowControls && (
        <div className="window-titlebar-controls">
          <button
            type="button"
            className="window-control-button"
            title={t("windowChrome.minimize")}
            aria-label={t("windowChrome.minimize")}
            onClick={() => runWindowAction(() => getCurrentWindow().minimize())}
          >
            <Minus size={15} />
          </button>
          <button
            type="button"
            className="window-control-button"
            title={
              maximized ? t("windowChrome.restore") : t("windowChrome.maximize")
            }
            aria-label={
              maximized ? t("windowChrome.restore") : t("windowChrome.maximize")
            }
            onClick={toggleMaximized}
          >
            {maximized ? <Copy size={13} /> : <Square size={13} />}
          </button>
          <button
            type="button"
            className="window-control-button window-control-close"
            title={t("windowChrome.close")}
            aria-label={t("windowChrome.close")}
            onClick={() => runWindowAction(() => getCurrentWindow().close())}
          >
            <X size={16} />
          </button>
        </div>
      )}
    </header>
  );
}

const RESIZE_EDGES = [
  ["north", "North"],
  ["south", "South"],
  ["east", "East"],
  ["west", "West"],
  ["north-west", "NorthWest"],
  ["north-east", "NorthEast"],
  ["south-west", "SouthWest"],
  ["south-east", "SouthEast"],
] as const;

export function WindowResizeHandles() {
  if (windowChrome.hasNativeWindowControls) return null;

  return (
    <div className="window-resize-handles" aria-hidden="true">
      {RESIZE_EDGES.map(([edge, direction]) => (
        <div
          key={edge}
          className={`window-resize-handle window-resize-${edge}`}
          onMouseDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            void getCurrentWindow()
              .startResizeDragging(direction)
              .catch((error) => console.warn("Unable to resize window", error));
          }}
        />
      ))}
    </div>
  );
}

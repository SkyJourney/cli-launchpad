import type { ReactNode, DragEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";
import { Toaster } from "sonner";
import { WindowResizeHandles, WindowTitlebar } from "./WindowTitlebar";
import { useWindowLevelBehaviors } from "../hooks/useWindowLevelBehaviors";
import type { WorkspaceContentWindowBeforeCloseHook } from "../lib/workspaceContentClose";
import { shouldCloseWorkspaceWindow } from "../lib/workspaceContentClose";

export function WorkspaceContentWindowShell({
  title,
  actions,
  draggable = false,
  onDragStart,
  beforeClose,
  isReady = true,
  onCloseBeforeReady,
  onCloseRequested,
  children,
}: {
  title: ReactNode;
  actions: ReactNode;
  draggable?: boolean;
  onDragStart?: (event: DragEvent<HTMLDivElement>) => void;
  beforeClose?: WorkspaceContentWindowBeforeCloseHook;
  isReady?: boolean;
  onCloseBeforeReady?: () => void;
  onCloseRequested: () => void;
  children: ReactNode;
}) {
  useWindowLevelBehaviors();
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">(() =>
    document.documentElement.dataset.theme === "light" ? "light" : "dark",
  );
  const closeRequestedRef = useRef(onCloseRequested);
  const beforeCloseRef = useRef(beforeClose);
  const isReadyRef = useRef(isReady);
  const closeBeforeReadyRef = useRef(onCloseBeforeReady);
  closeRequestedRef.current = onCloseRequested;
  beforeCloseRef.current = beforeClose;
  isReadyRef.current = isReady;
  closeBeforeReadyRef.current = onCloseBeforeReady;

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested((event) => {
        event.preventDefault();
        if (!isReadyRef.current) {
          closeBeforeReadyRef.current?.();
          return;
        }
        try {
          if (!shouldCloseWorkspaceWindow(beforeCloseRef.current)) return;
        } catch (reason) {
          console.error("Workspace content close hook rejected", reason);
          return;
        }
        closeRequestedRef.current();
      })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((reason) =>
        console.warn(
          "Unable to register workspace content close handler",
          reason,
        ),
      );
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const updateTheme = () =>
      setResolvedTheme(root.dataset.theme === "light" ? "light" : "dark");
    const observer = new MutationObserver(updateTheme);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    updateTheme();
    return () => observer.disconnect();
  }, []);

  return (
    <main className="standalone-pty-window standalone-workspace-content-window">
      <WindowTitlebar variant="standalone" actions={actions}>
        <div
          className="standalone-pty-title"
          draggable={draggable}
          onDragStart={onDragStart}
        >
          {title}
        </div>
      </WindowTitlebar>
      {children}
      <Toaster
        position="top-center"
        offset={{ top: "calc(var(--window-titlebar-height) + 6px)" }}
        theme={resolvedTheme}
        richColors
      />
      <WindowResizeHandles />
    </main>
  );
}

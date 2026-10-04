import type { ReactNode, DragEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef } from "react";
import { WindowResizeHandles, WindowTitlebar } from "./WindowTitlebar";
import type { WorkspaceContentWindowBeforeCloseHook } from "../lib/workspaceContentClose";
import { shouldCloseWorkspaceWindow } from "../lib/workspaceContentClose";

export function WorkspaceContentWindowShell({
  title,
  actions,
  draggable = false,
  onDragStart,
  beforeClose,
  onCloseRequested,
  children,
}: {
  title: ReactNode;
  actions: ReactNode;
  draggable?: boolean;
  onDragStart?: (event: DragEvent<HTMLDivElement>) => void;
  beforeClose?: WorkspaceContentWindowBeforeCloseHook;
  onCloseRequested: () => void;
  children: ReactNode;
}) {
  const closeRequestedRef = useRef(onCloseRequested);
  const beforeCloseRef = useRef(beforeClose);
  closeRequestedRef.current = onCloseRequested;
  beforeCloseRef.current = beforeClose;

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested((event) => {
        event.preventDefault();
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
      <WindowResizeHandles />
    </main>
  );
}

import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { RUST_EVENTS } from "../lib/eventNames";
import { usePtyWorkspace } from "./PtyWorkspace";

export function WorkspaceDataRestoreListener() {
  const { rehydrateWorkspace } = usePtyWorkspace();

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen(RUST_EVENTS.workspaceDataRestored, () => {
      void rehydrateWorkspace().catch((reason) =>
        console.error("Unable to reload restored workspace data", reason),
      );
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [rehydrateWorkspace]);

  return null;
}

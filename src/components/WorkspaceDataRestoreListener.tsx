import { useEffect } from "react";
import { RUST_EVENTS } from "../lib/eventNames";
import { onInboxEvent } from "../lib/windowInbox";
import { usePtyWorkspace } from "./PtyWorkspace";

export function WorkspaceDataRestoreListener() {
  const { rehydrateWorkspace } = usePtyWorkspace();

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onInboxEvent(RUST_EVENTS.workspaceDataRestored, () => {
      // 已卸载的 effect 不再处理订阅时冲刷出来的缓冲消息。
      if (disposed) return;
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

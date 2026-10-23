import { useEffect } from "react";
import type { WorkspacePersistence } from "./workspacePersistence";

/** The only effect that hydrates, auto-persists and flushes the workspace layout. */
export function useWorkspacePersistence(
  persistence: WorkspacePersistence,
  windows: { disposeAll(): void },
): void {
  useEffect(() => {
    const stopAutoPersist = persistence.startAutoPersist();
    void persistence.hydrate();
    return () => {
      stopAutoPersist();
      persistence.invalidateHydration();
      windows.disposeAll();
      persistence.dispose();
    };
  }, [persistence, windows]);
}

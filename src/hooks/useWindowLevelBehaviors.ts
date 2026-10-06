import { useEffect } from "react";

export function useWindowLevelBehaviors() {
  useEffect(() => {
    const preventNativeContextMenu = (event: MouseEvent) =>
      event.preventDefault();
    document.addEventListener("contextmenu", preventNativeContextMenu, true);
    return () =>
      document.removeEventListener(
        "contextmenu",
        preventNativeContextMenu,
        true,
      );
  }, []);
}

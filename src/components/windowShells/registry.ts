import type { ComponentType } from "react";
import { WINDOW_SHELLS } from "../../generated/windowShells";
import type { WindowShellProps } from "./types";

/** The shell of a non-primary window route, or null when the route has none. */
export function windowShellFor(
  route: string | null,
): ComponentType<WindowShellProps> | null {
  if (route === null) return null;
  return (
    (WINDOW_SHELLS as Record<string, ComponentType<WindowShellProps> | undefined>)[route] ??
    null
  );
}

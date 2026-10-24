import type { ComponentType } from "react";

/** A child window shell: renders its window from the launch parameters in the URL, or nothing. */
export interface WindowShellProps {
  search: URLSearchParams;
}

export type WindowShell = ComponentType<WindowShellProps>;

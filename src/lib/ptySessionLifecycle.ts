import type { PtySession } from "./tauri";

export function canTerminatePtySession(
  state: PtySession["state"] | null | undefined,
  handoffInProgress: boolean,
): boolean {
  return state === "running" && !handoffInProgress;
}

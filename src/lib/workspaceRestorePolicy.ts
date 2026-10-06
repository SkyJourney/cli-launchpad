export interface WorkspaceDataRestoreBlockers {
  runningPtyCount: number;
  dirtyFileCount: number;
  detachedWindowCount: number;
}

export function hasWorkspaceDataRestoreBlockers(
  blockers: WorkspaceDataRestoreBlockers,
): boolean {
  return (
    blockers.runningPtyCount > 0 ||
    blockers.dirtyFileCount > 0 ||
    blockers.detachedWindowCount > 0
  );
}

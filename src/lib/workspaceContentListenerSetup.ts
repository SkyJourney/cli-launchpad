export type WorkspaceContentUnlisten = () => void;

export async function setupWorkspaceContentListeners(args: {
  registrations: Promise<WorkspaceContentUnlisten>[];
  isDisposed: () => boolean;
  onError: (failures: unknown[]) => void;
}): Promise<WorkspaceContentUnlisten> {
  const results = await Promise.allSettled(args.registrations);
  const unlisten = results.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    unlisten.forEach((stop) => {
      try {
        stop();
      } catch (error) {
        console.warn("Workspace content listener cleanup failed", error);
      }
    });
  };

  if (args.isDisposed() || failures.length > 0) cleanup();
  if (failures.length > 0) args.onError(failures);
  return cleanup;
}

export interface WorkspaceContentWindowIdentity {
  windowLabel: string;
}

export interface WorkspaceContentWindowRecord extends WorkspaceContentWindowIdentity {
  timer: number;
  cleanup?: () => void;
}

/** Retains an async listener's unlisten callback even when cleanup wins the race. */
export function retainAsyncUnlisten(
  register: () => Promise<() => void>,
  onError: (error: unknown) => void = (error) =>
    console.error("Workspace content listener registration failed", error),
): () => void {
  let disposed = false;
  let unlisten: (() => void) | undefined;

  void Promise.resolve()
    .then(register)
    .then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    })
    .catch(onError);

  return () => {
    if (disposed) return;
    disposed = true;
    unlisten?.();
    unlisten = undefined;
  };
}

function cleanupRecord(record: WorkspaceContentWindowRecord): void {
  try {
    record.cleanup?.();
  } catch (error) {
    console.error("Workspace content listener cleanup failed", error);
  }
}

/** Shared pending-window registration and timer mechanics for all content kinds. */
export function registerPendingWorkspaceContentWindow<
  Record extends WorkspaceContentWindowRecord,
>(args: {
  pending: Map<string, Record>;
  key: string;
  record: Omit<Record, "timer">;
  timeoutMs: number;
  onTimeout: (record: Record) => void;
}): Record {
  if (args.pending.has(args.key)) {
    throw new Error(`工作区内容窗口正在启动: ${args.key}`);
  }
  let registered: Record;
  const timer = globalThis.setTimeout(() => {
    if (args.pending.get(args.key) !== registered) return;
    args.pending.delete(args.key);
    try {
      args.onTimeout(registered);
    } finally {
      cleanupRecord(registered);
    }
  }, args.timeoutMs);
  registered = { ...args.record, timer } as Record;
  args.pending.set(args.key, registered);
  return registered;
}

/** Removes one pending registration and always cancels its timeout. */
export function takePendingWorkspaceContentWindow<
  Record extends WorkspaceContentWindowRecord,
>(
  pending: Map<string, Record>,
  key: string,
  expectedWindowLabel?: string,
): Record | undefined {
  const record = pending.get(key);
  if (
    !record ||
    (expectedWindowLabel && record.windowLabel !== expectedWindowLabel)
  ) {
    return undefined;
  }
  pending.delete(key);
  globalThis.clearTimeout(record.timer);
  cleanupRecord(record);
  return record;
}

/** Clears all pending timers and lets each owner settle its domain promise. */
export function clearPendingWorkspaceContentWindows<
  Record extends WorkspaceContentWindowRecord,
>(pending: Map<string, Record>, onClear: (record: Record) => void): void {
  for (const [key, record] of pending) {
    const removed = takePendingWorkspaceContentWindow(
      pending,
      key,
      record.windowLabel,
    );
    if (removed) {
      try {
        onClear(removed);
      } catch (error) {
        console.error("Workspace content window cleanup failed", error);
      }
    }
  }
}

/** Atomically moves an accepted pending window to the detached owner map. */
export function promotePendingWorkspaceContentWindow<
  Pending extends WorkspaceContentWindowRecord,
  Detached,
>(args: {
  pending: Map<string, Pending>;
  detached: Map<string, Detached>;
  key: string;
  expectedWindowLabel?: string;
  toDetached: (record: Pending) => Detached;
}): Pending | undefined {
  const record = takePendingWorkspaceContentWindow(
    args.pending,
    args.key,
    args.expectedWindowLabel,
  );
  if (!record) return undefined;
  args.detached.set(args.key, args.toDetached(record));
  return record;
}

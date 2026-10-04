export interface WorkspaceContentWindowIdentity {
  windowLabel: string;
}

export interface WorkspaceContentWindowRecord extends WorkspaceContentWindowIdentity {
  timer: number;
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
    args.onTimeout(registered);
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
  Detached extends WorkspaceContentWindowIdentity,
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

import type { AppErrorState } from "../../lib/appErrors";
export interface PersistenceStatus {
  hydrationError: AppErrorState | null;
  layoutSaveError: AppErrorState | null;
  layoutResetError: AppErrorState | null;
  layoutResetPending: boolean;
}

const INITIAL_STATUS: PersistenceStatus = {
  hydrationError: null,
  layoutSaveError: null,
  layoutResetError: null,
  layoutResetPending: false,
};

/**
 * 持久化状态的小型 store：宿主经 useSyncExternalStore 读取；只有字段真正变化时才通知监听者。
 */
export function createPersistenceStatus() {
  let status: PersistenceStatus = INITIAL_STATUS;
  const listeners = new Set<() => void>();
  return {
    get: (): PersistenceStatus => status,
    set: (patch: Partial<PersistenceStatus>) => {
      const next = { ...status, ...patch };
      const changed = (Object.keys(next) as (keyof PersistenceStatus)[]).some(
        // Error states are rebuilt on every failure, so compare their content, not identity.
        (key) => JSON.stringify(next[key]) !== JSON.stringify(status[key]),
      );
      if (!changed) return;
      status = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

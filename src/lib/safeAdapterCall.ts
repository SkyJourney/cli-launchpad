const MAX_REPORTED_KEYS = 200;
const reported = new Set<string>();

/**
 * 隔离一次同步的适配器调用：`call` 抛错时记录一次并返回 `fallback()`。
 * 同一“标签加消息”只记录一次，避免渲染路径上反复调用时刷屏。
 * `fallback` 自己抛错不会被吞掉。只用于同步调用；Promise 的失败由调用方各自处理。
 */
export function safeAdapterCall<T>(
  label: string,
  call: () => T,
  fallback: () => T,
): T {
  try {
    return call();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const key = `${label}::${message}`;
    if (!reported.has(key)) {
      if (reported.size >= MAX_REPORTED_KEYS) reported.clear();
      reported.add(key);
      console.error(`[workspace.adapter_call_failed] ${label}`, error);
    }
    return fallback();
  }
}

export function resetSafeAdapterCallReports(): void {
  reported.clear();
}

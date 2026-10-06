/** Waits for a bounded interval, resolving immediately when the owner aborts. */
export function abortableDelay(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const finish = () => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = globalThis.setTimeout(finish, delayMs);
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      finish();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

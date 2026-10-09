import { abortableDelay } from "./abortableDelay";

export type Unlisten = () => void;
/** 第 retryIndex（从 0 起）次重试之前等待的毫秒数。 */
export type RetryDelay = (retryIndex: number) => number;
export type RetrySleep = (
  delayMs: number,
  signal: AbortSignal,
) => Promise<void>;

export function exponentialDelay(options: {
  baseMs: number;
  capMs: number;
}): RetryDelay {
  const { baseMs, capMs } = options;
  if (
    !Number.isFinite(baseMs) ||
    baseMs < 0 ||
    !Number.isFinite(capMs) ||
    capMs < baseMs
  ) {
    throw new RangeError(
      `Invalid exponential delay: baseMs=${baseMs} capMs=${capMs}`,
    );
  }
  return (retryIndex) => {
    if (!Number.isInteger(retryIndex) || retryIndex < 0) {
      throw new RangeError(
        `retryIndex must be a non-negative integer: ${retryIndex}`,
      );
    }
    return Math.min(capMs, baseMs * 2 ** Math.min(retryIndex, 30));
  };
}

export type RetryOutcome<T> =
  | { status: "succeeded"; value: T; attempts: number }
  | { status: "exhausted"; lastError: unknown; attempts: number }
  | { status: "stopped"; lastError: unknown; attempts: number }
  | { status: "aborted"; attempts: number };

export interface RetryOptions {
  /** 含第一次在内的总尝试次数，必须是大于等于 1 的整数。 */
  maxAttempts: number;
  delayMs: RetryDelay;
  signal?: AbortSignal;
  sleep?: RetrySleep;
  /** 返回 false 时不再重试，结果为 stopped。 */
  shouldRetry?: (reason: unknown, attempt: number) => boolean;
  /** 次数用尽时恰好调用一次（stopped 与 aborted 不调用）。 */
  onExhausted?: (lastError: unknown, attempts: number) => void;
}

export async function retryWithBackoff<T>(
  operation: (attempt: number) => Promise<T> | T,
  options: RetryOptions,
): Promise<RetryOutcome<T>> {
  if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1) {
    throw new RangeError(
      `maxAttempts must be an integer >= 1: ${options.maxAttempts}`,
    );
  }
  const signal = options.signal ?? new AbortController().signal;
  const sleep = options.sleep ?? abortableDelay;
  let attempts = 0;
  let lastError: unknown;

  while (attempts < options.maxAttempts) {
    if (signal.aborted) return { status: "aborted", attempts };
    attempts += 1;
    try {
      const value = await operation(attempts);
      return { status: "succeeded", value, attempts };
    } catch (reason) {
      lastError = reason;
    }
    if (signal.aborted) return { status: "aborted", attempts };
    if (options.shouldRetry && !options.shouldRetry(lastError, attempts)) {
      return { status: "stopped", lastError, attempts };
    }
    if (attempts >= options.maxAttempts) break;
    await sleep(options.delayMs(attempts - 1), signal);
  }

  if (signal.aborted) return { status: "aborted", attempts };
  try {
    options.onExhausted?.(lastError, attempts);
  } catch (error) {
    console.error("retryWithBackoff onExhausted failed", error);
  }
  return { status: "exhausted", lastError, attempts };
}

export interface IsolatedRegistration {
  name: string;
  register: () => Promise<Unlisten>;
}

export interface IsolatedRegistrationFailure {
  name: string;
  attempts: number;
  lastError: unknown;
}

export interface IsolatedRegistrationResult {
  /** 幂等；容忍单个 Unlisten 抛错。 */
  cleanup: Unlisten;
  failed: IsolatedRegistrationFailure[];
}

export async function registerIsolated(args: {
  registrations: readonly IsolatedRegistration[];
  maxAttempts: number;
  delayMs: RetryDelay;
  signal: AbortSignal;
  sleep?: RetrySleep;
}): Promise<IsolatedRegistrationResult> {
  const unlisteners: Unlisten[] = [];
  let cleaned = false;

  const stopSafely = (stop: Unlisten) => {
    try {
      stop();
    } catch (error) {
      console.warn("Listener cleanup failed", error);
    }
  };
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    for (const stop of unlisteners.splice(0)) stopSafely(stop);
  };
  const retain = (stop: Unlisten) => {
    if (cleaned) stopSafely(stop);
    else unlisteners.push(stop);
  };
  args.signal.addEventListener("abort", cleanup, { once: true });
  if (args.signal.aborted) cleanup();

  const failed: IsolatedRegistrationFailure[] = [];
  await Promise.all(
    args.registrations.map(async (registration) => {
      const outcome = await retryWithBackoff(() => registration.register(), {
        maxAttempts: args.maxAttempts,
        delayMs: args.delayMs,
        signal: args.signal,
        sleep: args.sleep,
      });
      if (outcome.status === "succeeded") {
        retain(outcome.value);
      } else if (outcome.status === "exhausted") {
        failed.push({
          name: registration.name,
          attempts: outcome.attempts,
          lastError: outcome.lastError,
        });
      }
    }),
  );
  return { cleanup, failed };
}

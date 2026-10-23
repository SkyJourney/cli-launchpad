import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exponentialDelay,
  registerIsolated,
  retryWithBackoff,
} from "./retryPolicy";

afterEach(() => {
  vi.useRealTimers();
});

function recordingSleep() {
  const delays: number[] = [];
  const sleep = async (delayMs: number) => {
    delays.push(delayMs);
  };
  return { delays, sleep };
}

describe("exponentialDelay", () => {
  it("doubles from the base and stops at the cap", () => {
    const delay = exponentialDelay({ baseMs: 500, capMs: 4000 });
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((index) => delay(index))).toEqual([
      500, 1000, 2000, 4000, 4000, 4000, 4000, 4000,
    ]);
    expect(delay(1000)).toBe(4000);
  });

  it("rejects invalid options and invalid indexes", () => {
    expect(() => exponentialDelay({ baseMs: 5000, capMs: 4000 })).toThrow(
      RangeError,
    );
    expect(() => exponentialDelay({ baseMs: -1, capMs: 4000 })).toThrow(
      RangeError,
    );
    const delay = exponentialDelay({ baseMs: 500, capMs: 4000 });
    expect(() => delay(-1)).toThrow(RangeError);
    expect(() => delay(1.5)).toThrow(RangeError);
  });
});

describe("retryWithBackoff", () => {
  it("returns the first successful result without sleeping", async () => {
    const operation = vi.fn(async () => "ok");
    const { delays, sleep } = recordingSleep();
    const outcome = await retryWithBackoff(operation, {
      maxAttempts: 3,
      delayMs: () => 10,
      sleep,
    });
    expect(outcome).toEqual({ status: "succeeded", value: "ok", attempts: 1 });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it("retries until the attempt budget is exhausted and reports once", async () => {
    const error = new Error("nope");
    const operation = vi.fn(async () => {
      throw error;
    });
    const { delays, sleep } = recordingSleep();
    const onExhausted = vi.fn();
    const outcome = await retryWithBackoff(operation, {
      maxAttempts: 3,
      delayMs: exponentialDelay({ baseMs: 100, capMs: 150 }),
      sleep,
      onExhausted,
    });
    expect(outcome).toEqual({
      status: "exhausted",
      lastError: error,
      attempts: 3,
    });
    expect(operation).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([100, 150]);
    expect(onExhausted).toHaveBeenCalledTimes(1);
    expect(onExhausted).toHaveBeenCalledWith(error, 3);
  });

  it("succeeds after transient failures and passes the 1-based attempt", async () => {
    const seen: number[] = [];
    const operation = vi.fn(async (attempt: number) => {
      seen.push(attempt);
      if (attempt < 3) throw new Error("transient");
      return 7;
    });
    const { delays, sleep } = recordingSleep();
    const outcome = await retryWithBackoff(operation, {
      maxAttempts: 5,
      delayMs: (retryIndex) => retryIndex * 10,
      sleep,
    });
    expect(outcome).toEqual({ status: "succeeded", value: 7, attempts: 3 });
    expect(seen).toEqual([1, 2, 3]);
    expect(delays).toEqual([0, 10]);
  });

  it("treats a synchronous throw as a failed attempt", async () => {
    const operation = vi.fn((): string => {
      throw new Error("sync");
    });
    const { sleep } = recordingSleep();
    const outcome = await retryWithBackoff(operation, {
      maxAttempts: 2,
      delayMs: () => 0,
      sleep,
    });
    expect(outcome.status).toBe("exhausted");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("stops immediately when shouldRetry declines", async () => {
    const error = new Error("fatal");
    const operation = vi.fn(async () => {
      throw error;
    });
    const { delays, sleep } = recordingSleep();
    const onExhausted = vi.fn();
    const outcome = await retryWithBackoff(operation, {
      maxAttempts: 5,
      delayMs: () => 10,
      sleep,
      shouldRetry: () => false,
      onExhausted,
    });
    expect(outcome).toEqual({
      status: "stopped",
      lastError: error,
      attempts: 1,
    });
    expect(delays).toEqual([]);
    expect(onExhausted).not.toHaveBeenCalled();
  });

  it("does not call the operation when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const operation = vi.fn(async () => "never");
    const outcome = await retryWithBackoff(operation, {
      maxAttempts: 3,
      delayMs: () => 0,
      signal: controller.signal,
    });
    expect(outcome).toEqual({ status: "aborted", attempts: 0 });
    expect(operation).not.toHaveBeenCalled();
  });

  it("stops without exhausting when the signal aborts during a sleep", async () => {
    const controller = new AbortController();
    const operation = vi.fn(async () => {
      throw new Error("fail");
    });
    const onExhausted = vi.fn();
    const outcome = await retryWithBackoff(operation, {
      maxAttempts: 5,
      delayMs: () => 50,
      signal: controller.signal,
      sleep: async () => {
        controller.abort();
      },
      onExhausted,
    });
    expect(outcome).toEqual({ status: "aborted", attempts: 1 });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(onExhausted).not.toHaveBeenCalled();
  });

  it("uses cancellable timers by default and leaves none behind after an abort", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const operation = vi.fn(async () => {
      throw new Error("fail");
    });
    const pending = retryWithBackoff(operation, {
      maxAttempts: 3,
      delayMs: () => 1000,
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    controller.abort();
    await expect(pending).resolves.toEqual({ status: "aborted", attempts: 1 });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(operation).toHaveBeenCalledTimes(1);
  });
});

function makeRegistration(name: string, results: Array<Error | null>) {
  const unlisten = vi.fn();
  let index = 0;
  const register = vi.fn(async () => {
    const next = results[Math.min(index, results.length - 1)];
    index += 1;
    if (next) throw next;
    return unlisten;
  });
  return { name, register, unlisten };
}

const instant = async () => undefined;

describe("registerIsolated", () => {
  it("keeps every registration and cleans them once", async () => {
    const first = makeRegistration("a", [null]);
    const second = makeRegistration("b", [null]);
    const result = await registerIsolated({
      registrations: [first, second],
      maxAttempts: 3,
      delayMs: () => 0,
      signal: new AbortController().signal,
      sleep: instant,
    });
    expect(result.failed).toEqual([]);
    expect(first.unlisten).not.toHaveBeenCalled();
    result.cleanup();
    result.cleanup();
    expect(first.unlisten).toHaveBeenCalledTimes(1);
    expect(second.unlisten).toHaveBeenCalledTimes(1);
  });

  it("reports only the permanently failing registration and keeps the others", async () => {
    const error = new Error("denied");
    const healthy = makeRegistration("healthy", [null]);
    const broken = makeRegistration("broken", [error]);
    const result = await registerIsolated({
      registrations: [healthy, broken],
      maxAttempts: 2,
      delayMs: () => 0,
      signal: new AbortController().signal,
      sleep: instant,
    });
    expect(result.failed).toEqual([
      { name: "broken", attempts: 2, lastError: error },
    ]);
    expect(broken.register).toHaveBeenCalledTimes(2);
    expect(healthy.register).toHaveBeenCalledTimes(1);
    expect(healthy.unlisten).not.toHaveBeenCalled();
    result.cleanup();
    expect(healthy.unlisten).toHaveBeenCalledTimes(1);
    expect(broken.unlisten).not.toHaveBeenCalled();
  });

  it("recovers a transient failure on retry", async () => {
    const flaky = makeRegistration("flaky", [new Error("once"), null]);
    const result = await registerIsolated({
      registrations: [flaky],
      maxAttempts: 3,
      delayMs: () => 0,
      signal: new AbortController().signal,
      sleep: instant,
    });
    expect(result.failed).toEqual([]);
    expect(flaky.register).toHaveBeenCalledTimes(2);
    result.cleanup();
    expect(flaky.unlisten).toHaveBeenCalledTimes(1);
  });

  it("unlistens a registration that resolves after the signal aborted", async () => {
    const unlisten = vi.fn();
    let resolveRegistration: (stop: () => void) => void = () => undefined;
    const register = vi.fn(
      () =>
        new Promise<() => void>((resolve) => {
          resolveRegistration = resolve;
        }),
    );
    const controller = new AbortController();
    const pending = registerIsolated({
      registrations: [{ name: "late", register }],
      maxAttempts: 3,
      delayMs: () => 0,
      signal: controller.signal,
      sleep: instant,
    });
    controller.abort();
    resolveRegistration(unlisten);
    const result = await pending;
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(result.failed).toEqual([]);
    expect(register).toHaveBeenCalledTimes(1);
  });

  it("keeps cleaning when one unlisten throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const throwing = makeRegistration("throwing", [null]);
    throwing.unlisten.mockImplementation(() => {
      throw new Error("unlisten failed");
    });
    const other = makeRegistration("other", [null]);
    const result = await registerIsolated({
      registrations: [throwing, other],
      maxAttempts: 1,
      delayMs: () => 0,
      signal: new AbortController().signal,
      sleep: instant,
    });
    result.cleanup();
    expect(other.unlisten).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("does not make healthy registrations wait for a failing one", async () => {
    let releaseSleep: () => void = () => undefined;
    const sleep = () =>
      new Promise<void>((resolve) => {
        releaseSleep = resolve;
      });
    const broken = makeRegistration("broken", [new Error("once"), null]);
    const healthy = makeRegistration("healthy", [null]);
    let settled = false;
    const pending = registerIsolated({
      registrations: [broken, healthy],
      maxAttempts: 2,
      delayMs: () => 1000,
      signal: new AbortController().signal,
      sleep,
    }).then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(healthy.register).toHaveBeenCalledTimes(1);
    expect(broken.register).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    releaseSleep();
    const result = await pending;
    expect(broken.register).toHaveBeenCalledTimes(2);
    expect(result.failed).toEqual([]);
  });
});

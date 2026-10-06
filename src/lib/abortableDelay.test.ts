import { afterEach, describe, expect, it, vi } from "vitest";
import { abortableDelay } from "./abortableDelay";

describe("abortableDelay", () => {
  afterEach(() => vi.useRealTimers());

  it("clears its timer and resolves when aborted", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const wait = abortableDelay(10_000, controller.signal);

    controller.abort();
    await wait;

    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves immediately for an already aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      abortableDelay(10_000, controller.signal),
    ).resolves.toBeUndefined();
  });
});

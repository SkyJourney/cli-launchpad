import { describe, expect, it } from "vitest";
import {
  PTY_OWNER_LOST_MAX_ATTEMPTS,
  ptyOwnerLostRetryDelay,
} from "./ptyOwnerLostRecovery";

describe("PTY owner-lost recovery policy", () => {
  it("allows at most 8 attempts with 500 ms exponential backoff capped at 4000 ms", () => {
    expect(PTY_OWNER_LOST_MAX_ATTEMPTS).toBe(8);
    const delays = Array.from(
      { length: PTY_OWNER_LOST_MAX_ATTEMPTS - 1 },
      (_unused, retryIndex) => ptyOwnerLostRetryDelay(retryIndex),
    );
    expect(delays).toEqual([500, 1000, 2000, 4000, 4000, 4000, 4000]);
    expect(delays.reduce((sum, delay) => sum + delay, 0)).toBe(19_500);
  });

  it("rejects a negative or fractional retry index", () => {
    expect(() => ptyOwnerLostRetryDelay(-1)).toThrow(RangeError);
    expect(() => ptyOwnerLostRetryDelay(0.5)).toThrow(RangeError);
  });
});

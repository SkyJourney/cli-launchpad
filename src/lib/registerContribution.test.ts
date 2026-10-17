import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearContributionFailures,
  getContributionFailures,
  registerContributionSafely,
} from "./registerContribution";

afterEach(() => {
  clearContributionFailures();
  vi.restoreAllMocks();
});

describe("registerContributionSafely", () => {
  it("returns the unregister function of an accepted contribution", () => {
    const dispose = vi.fn();
    const unregister = registerContributionSafely("test", "ok", () => dispose);

    expect(unregister).toBe(dispose);
    expect(getContributionFailures()).toEqual([]);
  });

  it("records a rejected contribution, logs it and returns a no-op unregister", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = new Error("版本不符");

    const unregister = registerContributionSafely("test", "bad", () => {
      throw failure;
    });

    expect(() => unregister()).not.toThrow();
    expect(getContributionFailures()).toEqual([
      { registry: "test", id: "bad", error: failure },
    ]);
    expect(error).toHaveBeenCalledWith(
      "[bootstrap.contribution_rejected] test:bad",
      failure,
    );
  });
});

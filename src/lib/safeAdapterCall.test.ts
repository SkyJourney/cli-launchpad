import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetSafeAdapterCallReports,
  safeAdapterCall,
} from "./safeAdapterCall";

describe("safeAdapterCall", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetSafeAdapterCallReports();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("returns the value of the call and never evaluates the fallback", () => {
    const fallback = vi.fn(() => "fallback");

    expect(safeAdapterCall("presentation:file", () => "value", fallback)).toBe(
      "value",
    );
    expect(fallback).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("returns the fallback and logs the label and the error when the call throws", () => {
    const failure = new Error("presentation boom");

    const result = safeAdapterCall(
      "presentation:file",
      () => {
        throw failure;
      },
      () => "fallback",
    );

    expect(result).toBe("fallback");
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      "[workspace.adapter_call_failed] presentation:file",
      failure,
    );
  });

  it("logs a repeated failure once per label and message", () => {
    const failing = (message: string) => () => {
      throw new Error(message);
    };

    for (let index = 0; index < 5; index += 1) {
      safeAdapterCall("presentation:file", failing("same"), () => null);
    }
    expect(errorSpy).toHaveBeenCalledTimes(1);

    safeAdapterCall("presentation:file", failing("different"), () => null);
    safeAdapterCall("projectContext:file", failing("same"), () => null);
    expect(errorSpy).toHaveBeenCalledTimes(3);
  });

  it("does not hide an error thrown by the fallback itself", () => {
    expect(() =>
      safeAdapterCall(
        "presentation:file",
        () => {
          throw new Error("call failed");
        },
        () => {
          throw new Error("fallback failed");
        },
      ),
    ).toThrow("fallback failed");
  });
});

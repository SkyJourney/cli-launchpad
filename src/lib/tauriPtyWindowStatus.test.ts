import { describe, expect, it } from "vitest";
import { toPtySessionWindowStatus } from "./tauri";

describe("toPtySessionWindowStatus", () => {
  it("maps a running report with its owner label", () => {
    expect(
      toPtySessionWindowStatus({ status: "running", ownerWindowLabel: "main" }),
    ).toEqual({ state: "running", ownerLabel: "main" });
  });

  it("maps an owned-by-another-window report with the owner label", () => {
    expect(
      toPtySessionWindowStatus({
        status: "ownedByAnotherWindow",
        ownerWindowLabel: "terminal-A",
      }),
    ).toEqual({ state: "ownedByAnotherWindow", ownerLabel: "terminal-A" });
  });

  it("maps an ended report without an owner label", () => {
    const mapped = toPtySessionWindowStatus({
      status: "ended",
      ownerWindowLabel: null,
    });
    expect(mapped).toEqual({ state: "ended", ownerLabel: null });
    // 反向断言：缺少所有者时是严格的 null，不是 undefined。
    expect(mapped.ownerLabel).toBeNull();
  });

  it("rejects an unknown status string", () => {
    expect(() =>
      toPtySessionWindowStatus({
        status: "paused" as never,
        ownerWindowLabel: null,
      }),
    ).toThrow("Unknown PTY window status");
  });
});

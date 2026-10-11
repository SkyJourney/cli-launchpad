import { describe, expect, it } from "vitest";
import { parseExitRequestedPayload } from "./exitRequest";

describe("parseExitRequestedPayload", () => {
  it("accepts a complete payload", () => {
    const result = parseExitRequestedPayload({
      requestId: "r1",
      ptyCount: 2,
      executionTaskCount: 3,
    });
    expect(result).toEqual({
      requestId: "r1",
      ptyCount: 2,
      executionTaskCount: 3,
    });
    expect(Object.keys(result ?? {}).sort()).toEqual([
      "executionTaskCount",
      "ptyCount",
      "requestId",
    ]);
  });

  it("defaults a missing executionTaskCount to zero", () => {
    expect(parseExitRequestedPayload({ requestId: "r1", ptyCount: 1 })).toEqual(
      {
        requestId: "r1",
        ptyCount: 1,
        executionTaskCount: 0,
      },
    );
    // a present but non-finite count is also read as zero (decision of 2026-10-11)
    expect(
      parseExitRequestedPayload({
        requestId: "r1",
        ptyCount: 1,
        executionTaskCount: "2",
      }),
    ).toEqual({ requestId: "r1", ptyCount: 1, executionTaskCount: 0 });
  });

  it("rejects a missing or empty requestId", () => {
    for (const raw of [
      { ptyCount: 0 },
      { requestId: "", ptyCount: 0 },
      { requestId: "   ", ptyCount: 0 },
      { requestId: 7, ptyCount: 0 },
      { requestId: null, ptyCount: 0 },
    ]) {
      expect(parseExitRequestedPayload(raw), JSON.stringify(raw)).toBeNull();
    }
  });

  it("rejects non-object payloads and non-numeric counts", () => {
    for (const raw of [
      null,
      undefined,
      "x",
      42,
      [],
      { requestId: "r", ptyCount: -1 },
      { requestId: "r", ptyCount: Number.NaN },
      { requestId: "r", ptyCount: "0" },
      { requestId: "r", ptyCount: 0, executionTaskCount: -1 },
    ]) {
      expect(parseExitRequestedPayload(raw), String(raw)).toBeNull();
    }
  });
});

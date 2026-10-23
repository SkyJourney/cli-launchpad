import { describe, expect, it } from "vitest";
import {
  exitCountsGrew,
  parseExitImpactsView,
  parseExitRequestedPayload,
} from "./exitRequest";

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

describe("exit impacts view (m6-101)", () => {
  const valid = () => ({
    requestId: "r1",
    ptyCount: 2,
    executionTaskCount: 1,
    dirtyFiles: [{ documentId: "d1", relativePath: "a.ts" }],
    requiresPrompt: true,
  });

  it("PV-1 accepts a complete impacts view for the expected request", () => {
    const raw = valid();
    const parsed = parseExitImpactsView(raw, "r1");
    expect(parsed).toEqual(raw);
    expect(parsed).not.toBe(raw);
    expect(parsed?.dirtyFiles).not.toBe(raw.dirtyFiles);
  });

  it("PV-2 rejects a view for another request id or a non-string id", () => {
    expect(parseExitImpactsView(valid(), "r2")).toBeNull();
    expect(parseExitImpactsView({ ...valid(), requestId: 5 }, "r1")).toBeNull();
  });

  it("PV-3 rejects missing or malformed fields", () => {
    const { requiresPrompt: _omitted, ...withoutPrompt } = valid();
    const broken: unknown[] = [
      withoutPrompt,
      { ...valid(), requiresPrompt: "yes" },
      { ...valid(), dirtyFiles: "x" },
      { ...valid(), dirtyFiles: [null] },
      { ...valid(), dirtyFiles: [{ documentId: 1, relativePath: "a" }] },
      { ...valid(), dirtyFiles: [{ documentId: "d" }] },
      null,
      [],
      "x",
    ];
    for (const raw of broken) {
      expect(parseExitImpactsView(raw, "r1")).toBeNull();
    }
    expect(parseExitImpactsView(valid(), "r1")).not.toBeNull();
  });

  it("PV-4 rejects negative or non-finite counts and accepts zero", () => {
    for (const patch of [
      { ptyCount: -1 },
      { ptyCount: Number.NaN },
      { executionTaskCount: Number.POSITIVE_INFINITY },
      { executionTaskCount: "1" },
    ]) {
      expect(parseExitImpactsView({ ...valid(), ...patch }, "r1")).toBeNull();
    }
    expect(
      parseExitImpactsView(
        { ...valid(), ptyCount: 0, executionTaskCount: 0 },
        "r1",
      ),
    ).not.toBeNull();
  });

  it("PV-5 compares pty and execution task counts independently", () => {
    expect(
      exitCountsGrew(
        { ptyCount: 1, executionTaskCount: 1 },
        { ptyCount: 2, executionTaskCount: 1 },
      ),
    ).toBe(true);
    expect(
      exitCountsGrew(
        { ptyCount: 1, executionTaskCount: 1 },
        { ptyCount: 1, executionTaskCount: 2 },
      ),
    ).toBe(true);
    expect(
      exitCountsGrew(
        { ptyCount: 1, executionTaskCount: 1 },
        { ptyCount: 1, executionTaskCount: 1 },
      ),
    ).toBe(false);
    expect(
      exitCountsGrew(
        { ptyCount: 2, executionTaskCount: 2 },
        { ptyCount: 1, executionTaskCount: 1 },
      ),
    ).toBe(false);
    expect(
      exitCountsGrew(
        { ptyCount: 1, executionTaskCount: 1 },
        { ptyCount: 2, executionTaskCount: 0 },
      ),
    ).toBe(true);
  });
});

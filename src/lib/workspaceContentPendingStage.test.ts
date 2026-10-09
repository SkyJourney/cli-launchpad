import { describe, expect, it } from "vitest";
import {
  advancePendingWindowStage,
  initialPendingStage,
  reducePendingStage,
  type PendingWindowStage,
} from "./workspaceContentPendingStage";

describe("initialPendingStage", () => {
  it("starts files at creating and terminals at initSent", () => {
    expect(initialPendingStage("file")).toBe("creating");
    expect(initialPendingStage("pty")).toBe("initSent");
  });
});

describe("reducePendingStage for files", () => {
  it("walks creating, ready, initSent and attached in order", () => {
    expect(reducePendingStage("file", "creating", "windowReady")).toEqual({
      accepted: true,
      stage: "ready",
    });
    expect(reducePendingStage("file", "ready", "initSent")).toEqual({
      accepted: true,
      stage: "initSent",
    });
    expect(reducePendingStage("file", "initSent", "attachedAck")).toEqual({
      accepted: true,
      stage: "attached",
    });
  });

  it("rejects a duplicate windowReady once the window is ready or has its init", () => {
    for (const stage of ["ready", "initSent"] as PendingWindowStage[]) {
      expect(reducePendingStage("file", stage, "windowReady")).toEqual({
        accepted: false,
        reason: "duplicate",
      });
    }
  });

  it("rejects an init that is out of order or repeated", () => {
    expect(reducePendingStage("file", "creating", "initSent")).toEqual({
      accepted: false,
      reason: "out-of-order",
    });
    expect(reducePendingStage("file", "initSent", "initSent")).toEqual({
      accepted: false,
      reason: "duplicate",
    });
  });

  it("rejects an attached acknowledgement before the init was sent", () => {
    for (const stage of ["creating", "ready"] as PendingWindowStage[]) {
      expect(reducePendingStage("file", stage, "attachedAck")).toEqual({
        accepted: false,
        reason: "out-of-order",
      });
    }
    expect(reducePendingStage("file", "initSent", "attachedAck").accepted).toBe(
      true,
    );
  });
});

describe("reducePendingStage after attached", () => {
  it("rejects every event for both kinds", () => {
    for (const kind of ["file", "pty"] as const) {
      for (const event of ["windowReady", "initSent", "attachedAck"] as const) {
        expect(reducePendingStage(kind, "attached", event)).toEqual({
          accepted: false,
          reason: "already-attached",
        });
      }
    }
  });
});

describe("reducePendingStage for terminals", () => {
  it("accepts the ready event only from initSent and treats file-only events as not applicable", () => {
    expect(reducePendingStage("pty", "initSent", "attachedAck")).toEqual({
      accepted: true,
      stage: "attached",
    });
    for (const stage of ["creating", "ready"] as PendingWindowStage[]) {
      expect(reducePendingStage("pty", stage, "attachedAck")).toEqual({
        accepted: false,
        reason: "out-of-order",
      });
    }
    for (const event of ["windowReady", "initSent"] as const) {
      expect(reducePendingStage("pty", "initSent", event)).toEqual({
        accepted: false,
        reason: "not-applicable",
      });
    }
  });
});

describe("advancePendingWindowStage", () => {
  it("mutates the record only when the event is accepted", () => {
    const record = {
      kind: "file" as const,
      stage: "creating" as PendingWindowStage,
    };
    expect(advancePendingWindowStage(record, "attachedAck")).toBe(false);
    expect(record.stage).toBe("creating");
    expect(advancePendingWindowStage(record, "windowReady")).toBe(true);
    expect(record.stage).toBe("ready");
    expect(advancePendingWindowStage(record, "windowReady")).toBe(false);
    expect(record.stage).toBe("ready");
    expect(advancePendingWindowStage(record, "initSent")).toBe(true);
    expect(advancePendingWindowStage(record, "attachedAck")).toBe(true);
    expect(record.stage).toBe("attached");
  });
});

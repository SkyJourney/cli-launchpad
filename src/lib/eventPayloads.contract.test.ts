import { describe, expect, it } from "vitest";
import events from "../../contracts/events.json";
import { keysOf } from "../test/dtoKeys";
import type { WindowInboxSource } from "./tauri";
import type { InboxEvent } from "./windowInbox";
import type { PtySessionOwnerLostEvent } from "../workspace/windows/contentWindowOrchestrator";
import type { WorkspaceContentWindowLostEvent } from "../workspace/windows/protocolHandlers.file";

const fixtureFiles = import.meta.glob("../../contracts/fixtures/*.json", {
  eager: true,
  import: "default",
}) as Record<
  string,
  { cases: Array<{ name: string; value: Record<string, unknown> }> }
>;

/** 事件名 -> 载荷 fixture；null 表示没有 Rust 载荷（单元值或前端定义的载荷）。 */
const EVENT_PAYLOADS: Record<string, string | null> = {
  "app-exit-requested": "exit-requested-payload.json",
  "app-preferences": null,
  "execution-task-log": "execution-log-chunk.json",
  "execution-task-updated": "execution-task.json",
  "pty-session-owner-lost": "event-pty-session-owner-lost.json",
  "window-message": "event-inbox-message.json",
  "workspace-content-window-lost": "event-workspace-content-window-lost.json",
  "workspace-data-restored": null,
};

const fixture = (file: string) =>
  fixtureFiles[`../../contracts/fixtures/${file}`];

describe("event payload contract", () => {
  it("maps every contract event to a payload fixture or an explicit no-payload entry", () => {
    const contractEvents = events.items.map((item) => item.name).sort();

    expect(Object.keys(EVENT_PAYLOADS).sort()).toEqual(contractEvents);
    for (const [name, file] of Object.entries(EVENT_PAYLOADS)) {
      if (file === null) continue;
      expect(
        fixture(file),
        `事件 ${name} 的载荷 fixture ${file} 不存在`,
      ).toBeDefined();
    }
  });

  it("matches the window lost and owner lost payload shapes", () => {
    const lost = keysOf<WorkspaceContentWindowLostEvent>()(["windowLabel"]);
    const owner = keysOf<PtySessionOwnerLostEvent>()(["sessionId"]);

    for (const { name, value } of fixture(
      "event-workspace-content-window-lost.json",
    ).cases) {
      expect(Object.keys(value).sort(), name).toEqual([...lost].sort());
      expect(typeof value.windowLabel).toBe("string");
      expect(String(value.windowLabel).startsWith("workspace-content-")).toBe(
        true,
      );
    }
    for (const { name, value } of fixture("event-pty-session-owner-lost.json")
      .cases) {
      expect(Object.keys(value).sort(), name).toEqual([...owner].sort());
      expect(typeof value.sessionId).toBe("string");
    }
  });

  it("matches the inbox message envelope shape", () => {
    const message = keysOf<InboxEvent>()(["event", "payload", "seq", "source"]);
    const source = keysOf<WindowInboxSource>()(["label", "kind"]);
    const cases = fixture("event-inbox-message.json").cases;

    for (const { name, value } of cases) {
      expect(Object.keys(value).sort(), name).toEqual([...message].sort());
      expect(Number.isInteger(value.seq)).toBe(true);
      expect(typeof value.event).toBe("string");
      if (value.source !== null) {
        expect(Object.keys(value.source as object).sort(), name).toEqual(
          [...source].sort(),
        );
      }
    }
    expect(cases.some(({ value }) => value.source === null)).toBe(true);
    expect(cases.some(({ value }) => value.source !== null)).toBe(true);
  });
});

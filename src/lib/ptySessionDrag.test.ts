import { describe, expect, it } from "vitest";
import { encodePtySessionDrag, parsePtySessionDrag } from "./ptySessionDrag";

describe("PTY session drag payload", () => {
  it("keeps the source pane for a workspace move", () => {
    const payload = {
      instanceId: "session-a",
      sourcePaneId: "pane-a",
      sourceWindowLabel: "main" as const,
    };
    expect(parsePtySessionDrag(encodePtySessionDrag(payload))).toEqual(payload);
  });

  it("keeps the source window for a detached return", () => {
    const payload = {
      instanceId: "session-a",
      sourceWindowLabel: "terminal-8e783338-f464-4b10-b15e-b534748c6241",
    };
    expect(parsePtySessionDrag(encodePtySessionDrag(payload))).toEqual(payload);
  });

  it("ignores unrelated or malformed dropped text", () => {
    expect(parsePtySessionDrag("a file path")).toBeNull();
    expect(parsePtySessionDrag("cli-launchpad-pty-v1:{")).toBeNull();
    expect(
      parsePtySessionDrag(
        'cli-launchpad-pty-v1:{"instanceId":"session-a","sourceWindowLabel":"terminal-other"}',
      ),
    ).toBeNull();
    expect(
      parsePtySessionDrag(
        'cli-launchpad-pty-v1:{"instanceId":"session-a","sourceWindowLabel":"main"}',
      ),
    ).toBeNull();
  });
});

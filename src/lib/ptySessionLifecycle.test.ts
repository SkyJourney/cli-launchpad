import { describe, expect, it } from "vitest";
import { canTerminatePtySession } from "./ptySessionLifecycle";

describe("PTY session termination ownership", () => {
  it("allows the owning window to close a running session without keyboard focus", () => {
    expect(canTerminatePtySession("running", false)).toBe(true);
  });

  it("blocks termination while the PTY is being handed to another window", () => {
    expect(canTerminatePtySession("running", true)).toBe(false);
  });

  it("does not offer termination for a session that is not running", () => {
    expect(canTerminatePtySession("exited", false)).toBe(false);
    expect(canTerminatePtySession(null, false)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { hasWorkspaceDataRestoreBlockers } from "./workspaceRestorePolicy";

describe("workspace restore policy", () => {
  it("allows restore only when no PTY, dirty document, or detached window remains", () => {
    expect(
      hasWorkspaceDataRestoreBlockers({
        runningPtyCount: 0,
        dirtyFileCount: 0,
        detachedWindowCount: 0,
      }),
    ).toBe(false);
    for (const blockers of [
      { runningPtyCount: 1, dirtyFileCount: 0, detachedWindowCount: 0 },
      { runningPtyCount: 0, dirtyFileCount: 1, detachedWindowCount: 0 },
      { runningPtyCount: 0, dirtyFileCount: 0, detachedWindowCount: 1 },
    ]) {
      expect(hasWorkspaceDataRestoreBlockers(blockers)).toBe(true);
    }
  });
});

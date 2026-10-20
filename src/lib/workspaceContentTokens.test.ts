import { describe, expect, it } from "vitest";
import { WorkspaceContentCoordinator } from "./workspaceContentCoordinator";
import { newTransferId, newWindowToken } from "./workspaceContentLifecycle";

const REF = { kind: "pty", slotId: "slot-1" } as const;
const PANE = { kind: "pane", windowLabel: "main", paneId: "pane-1" } as const;
const WINDOW = { kind: "window", windowLabel: "terminal-1" } as const;

function detaching() {
  const coordinator = new WorkspaceContentCoordinator();
  coordinator.ensureAttached(REF, PANE);
  const begin = coordinator.beginDetach(REF, PANE, WINDOW, "transfer-1");
  expect(begin?.outcome).toBe("changed");
  return coordinator;
}

describe("handoff identity layers", () => {
  it("returns distinct non-empty values from every transfer id and window token factory call", () => {
    const coordinator = new WorkspaceContentCoordinator();
    const values = [
      newTransferId(),
      newTransferId(),
      newWindowToken(),
      newWindowToken(),
      coordinator.newTransferId(),
      coordinator.newTransferId(),
      coordinator.newWindowToken(),
      coordinator.newWindowToken(),
    ];

    expect(values.every((value) => value.trim().length > 0)).toBe(true);
    expect(new Set(values).size).toBe(values.length);
  });

  it("records the supplied window token on detachReady as a different identity from the transfer", () => {
    const coordinator = detaching();

    const ready = coordinator.completeHandoff(
      REF,
      "detachReady",
      "transfer-1",
      "window-token-1",
    );

    expect(ready?.outcome).toBe("changed");
    expect(coordinator.get(REF)).toMatchObject({
      phase: "detached",
      windowToken: "window-token-1",
    });
  });

  it("ignores detachReady when the window token is missing or equals the transfer id", () => {
    const missing = detaching();
    const same = detaching();

    const withoutToken = missing.completeHandoff(
      REF,
      "detachReady",
      "transfer-1",
      "",
    );
    const sameToken = same.completeHandoff(
      REF,
      "detachReady",
      "transfer-1",
      "transfer-1",
    );

    expect(withoutToken?.outcome).toBe("ignored");
    expect(missing.get(REF)?.phase).toBe("detaching");
    expect(sameToken?.outcome).toBe("ignored");
    expect(same.get(REF)?.phase).toBe("detaching");
  });

  it("keeps the window token across a return that has its own transfer id", () => {
    const coordinator = detaching();
    coordinator.completeHandoff(
      REF,
      "detachReady",
      "transfer-1",
      "window-token-1",
    );

    const returning = coordinator.beginReturn(
      REF,
      "return-1",
      "main",
      "pane-1",
    );
    const wrongId = coordinator.completeHandoff(
      REF,
      "returnReady",
      "window-token-1",
    );

    expect(returning?.outcome).toBe("changed");
    expect(coordinator.get(REF)).toMatchObject({
      phase: "returning",
      transferId: "return-1",
      windowToken: "window-token-1",
    });
    expect(wrongId?.outcome).toBe("ignored");
    expect(coordinator.get(REF)?.phase).toBe("returning");

    const done = coordinator.completeHandoff(REF, "returnReady", "return-1");
    expect(done?.outcome).toBe("changed");
    expect(coordinator.get(REF)?.phase).toBe("attached");
  });

  it("refuses to reuse the transfer id of a completed return", () => {
    const coordinator = detaching();
    coordinator.completeHandoff(
      REF,
      "detachReady",
      "transfer-1",
      "window-token-1",
    );
    coordinator.beginReturn(REF, "return-1", "main", "pane-1");
    coordinator.completeHandoff(REF, "returnReady", "return-1");
    coordinator.beginDetach(REF, PANE, WINDOW, "transfer-2");
    coordinator.completeHandoff(
      REF,
      "detachReady",
      "transfer-2",
      "window-token-2",
    );

    const replay = coordinator.beginReturn(REF, "return-1", "main", "pane-1");

    expect(replay).toBeNull();
    expect(coordinator.get(REF)?.phase).toBe("detached");
  });
});

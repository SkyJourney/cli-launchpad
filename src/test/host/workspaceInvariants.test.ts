import { describe, expect, it } from "vitest";
import { createWorkspacePane } from "../../lib/ptyWorkspaceLayout";
import type { WorkspacePaneContentRef } from "../../lib/tauri";
import { WorkspaceContentCoordinator } from "../../lib/workspaceContentCoordinator";
import {
  assertWorkspaceInvariants,
  type InvariantContext,
  type InvariantHost,
} from "./workspaceInvariants";

function pane(id: string, contents: WorkspacePaneContentRef[]) {
  return { ...createWorkspacePane(id, 1), contents };
}

function host(
  overrides: Partial<InvariantHost> & {
    context?: Partial<InvariantContext>;
  } = {},
): InvariantHost {
  const { context, ...rest } = overrides;
  return {
    errors: [],
    backend: { saved: [] },
    coordinator: undefined,
    ctx: () => ({
      tree: pane("pane-1", []),
      slots: [],
      fileDocuments: [],
      fileBuffers: {},
      detachedFileIds: new Set<string>(),
      detachedInstanceIds: new Set<string>(),
      ...context,
    }),
    ...rest,
  };
}

const paneOwner = (paneId: string) => ({
  kind: "pane" as const,
  windowLabel: "main",
  paneId,
});

const PTY: WorkspacePaneContentRef = { kind: "pty", slotId: "slot-1" };
const FILE: WorkspacePaneContentRef = { kind: "file", documentId: "doc-1" };

describe("workspace invariants", () => {
  it("accepts a consistent host", () => {
    const coordinator = new WorkspaceContentCoordinator();
    coordinator.ensureAttached(PTY, paneOwner("pane-1"));
    coordinator.ensureAttached(FILE, paneOwner("pane-1"));
    const context = {
      tree: pane("pane-1", [PTY, FILE]),
      slots: [{ instanceId: "slot-1" }],
      fileDocuments: [{ id: "doc-1" }],
    };

    expect(assertWorkspaceInvariants(host({ coordinator, context }))).toEqual({
      skipped: [],
    });
    expect(assertWorkspaceInvariants(host({ context }))).toEqual({
      skipped: ["I4", "I7"],
    });
  });

  it("I1 reports captured render errors", () => {
    expect(() =>
      assertWorkspaceInvariants(host({ errors: [new Error("boom")] })),
    ).toThrow(/workspace invariant I1 violated.*boom/);
  });

  it("I2 reports a saved layout that fails validation", () => {
    expect(() =>
      assertWorkspaceInvariants(
        host({
          backend: { saved: [{ layout: { schemaVersion: 4 } as never }] },
        }),
      ),
    ).toThrow(
      /workspace invariant I2 violated.*Workspace layout version is invalid/,
    );
  });

  it("I3 reports content that appears in two panes", () => {
    const tree = {
      kind: "split" as const,
      id: "split-1",
      direction: "horizontal" as const,
      ratio: 0.5,
      first: pane("pane-1", [PTY]),
      second: pane("pane-2", [PTY]),
    };
    const duplicated = host({
      context: { tree, slots: [{ instanceId: "slot-1" }] },
    });

    expect(() => assertWorkspaceInvariants(duplicated)).toThrow(
      /workspace invariant I3 violated.*pane-1.*pane-2/,
    );

    const distinct = host({
      context: {
        tree: {
          ...tree,
          second: pane("pane-2", [{ kind: "pty", slotId: "slot-2" }]),
        },
        slots: [{ instanceId: "slot-1" }, { instanceId: "slot-2" }],
      },
    });
    expect(() => assertWorkspaceInvariants(distinct)).not.toThrow();
  });

  it("I4 reports tree content without a matching coordinator state", () => {
    const coordinator = new WorkspaceContentCoordinator();
    const h = host({
      coordinator,
      context: {
        tree: pane("pane-1", [PTY]),
        slots: [{ instanceId: "slot-1" }],
      },
    });

    expect(() => assertWorkspaceInvariants(h)).toThrow(
      /workspace invariant I4 violated.*no coordinator state/,
    );

    coordinator.ensureAttached(PTY, paneOwner("pane-x"));
    expect(() => assertWorkspaceInvariants(h)).toThrow(
      /attached to pane pane-x but sits in pane pane-1/,
    );

    coordinator.ensureAttached(PTY, paneOwner("pane-1"));
    expect(() => assertWorkspaceInvariants(h)).not.toThrow();
  });

  it("I5 reports a slot that is neither in the tree nor window-owned", () => {
    const base = {
      slots: [{ instanceId: "slot-9" }],
      fileDocuments: [{ id: "doc-9" }],
    };

    expect(() => assertWorkspaceInvariants(host({ context: base }))).toThrow(
      /workspace invariant I5 violated.*slot-9/,
    );

    const slotOwned = host({
      context: { ...base, detachedInstanceIds: new Set(["slot-9"]) },
    });
    expect(() => assertWorkspaceInvariants(slotOwned)).toThrow(/doc-9/);

    const bothOwned = host({
      context: {
        ...base,
        detachedInstanceIds: new Set(["slot-9"]),
        detachedFileIds: new Set(["doc-9"]),
      },
    });
    expect(() => assertWorkspaceInvariants(bothOwned)).not.toThrow();
  });

  it("I6 reports a saving buffer unless pending saves are allowed", () => {
    const h = host({ context: { fileBuffers: { "doc-1": { saving: true } } } });

    expect(() => assertWorkspaceInvariants(h)).toThrow(
      /workspace invariant I6 violated.*doc-1/,
    );
    expect(() =>
      assertWorkspaceInvariants(h, { allowPendingSaves: true }),
    ).not.toThrow();
  });

  it("I7 reports detached ids that differ from the coordinator window-owned set", () => {
    const context = { detachedFileIds: new Set(["doc-1"]) };

    expect(() =>
      assertWorkspaceInvariants(
        host({ coordinator: new WorkspaceContentCoordinator(), context }),
      ),
    ).toThrow(/workspace invariant I7 violated.*detachedFileIds/);

    const withoutCoordinator = assertWorkspaceInvariants(host({ context }));
    expect(withoutCoordinator.skipped).toContain("I7");
  });

  it("skips I4 and I7 and says so when no coordinator is injected", () => {
    const failing = host({ errors: [new Error("boom")] });

    expect(() => assertWorkspaceInvariants(failing)).toThrow(
      "未注入 coordinator",
    );
    expect(() => assertWorkspaceInvariants(failing)).toThrow("I4、I7 已跳过");
    expect(assertWorkspaceInvariants(host()).skipped).toEqual(["I4", "I7"]);
  });
});

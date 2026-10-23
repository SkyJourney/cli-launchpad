// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import type { PtyWorkspaceSlot } from "../../components/WorkspacePtySessionRegistry";
import {
  createInitialHostSnapshot,
  WorkspaceHostStore,
  WorkspaceHostStoreContext,
  useWorkspaceSelector,
} from "./workspaceHostStore";

function slot(instanceId: string): PtyWorkspaceSlot {
  return {
    instanceId,
    directoryId: 1,
    directoryPath: "C:/project",
    projectName: "Project",
    toolKey: "claude",
    sequence: 1,
    title: { kind: "automatic" },
  } as unknown as PtyWorkspaceSlot;
}

describe("useWorkspaceSelector", () => {
  it("returns the selected slice and rerenders only when it changes", () => {
    const store = new WorkspaceHostStore(createInitialHostSnapshot("p1"));
    const wrapper = ({ children }: { children: ReactNode }) => (
      <WorkspaceHostStoreContext.Provider value={store}>
        {children}
      </WorkspaceHostStoreContext.Provider>
    );
    let renders = 0;
    const { result } = renderHook(
      () => {
        renders += 1;
        return useWorkspaceSelector((s) => s.focusedPaneId);
      },
      { wrapper },
    );

    expect(result.current).toBe("p1");

    const beforeIrrelevant = renders;
    act(() => {
      store.commit((l) => ({ ...l, treeRevision: l.treeRevision + 1 }), "r");
    });
    expect(result.current).toBe("p1");
    expect(renders).toBe(beforeIrrelevant);

    act(() => {
      store.commit((l) => ({ ...l, focusedPaneId: "p2" }), "f");
    });
    expect(result.current).toBe("p2");
    expect(renders).toBeGreaterThan(beforeIrrelevant);
  });

  it("uses the supplied equality function to keep a derived value stable", () => {
    const store = new WorkspaceHostStore(createInitialHostSnapshot("p1"));
    const wrapper = ({ children }: { children: ReactNode }) => (
      <WorkspaceHostStoreContext.Provider value={store}>
        {children}
      </WorkspaceHostStoreContext.Provider>
    );
    const { result } = renderHook(
      () =>
        useWorkspaceSelector(
          (s) => s.slots.map((item) => item.instanceId),
          (a, b) => a.length === b.length && a.every((v, i) => v === b[i]),
        ),
      { wrapper },
    );

    const first = result.current;
    expect(first).toEqual([]);
    act(() => {
      store.commit((l) => ({ ...l, slots: [] }), "empty");
    });
    expect(result.current).toBe(first);

    act(() => {
      store.commit((l) => ({ ...l, slots: [slot("s1")] }), "one");
    });
    expect(result.current).toEqual(["s1"]);
  });

  it("throws a clear error outside a provider", () => {
    const original = console.error;
    console.error = () => undefined;
    try {
      expect(() =>
        renderHook(() => useWorkspaceSelector((s) => s.tree)),
      ).toThrow("WorkspaceHostStoreContext is missing");
    } finally {
      console.error = original;
    }
  });
});

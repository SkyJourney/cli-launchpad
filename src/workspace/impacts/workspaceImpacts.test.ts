import { describe, expect, it, vi } from "vitest";
import type { WorkspaceContentAdapter } from "../../components/workspaceContentAdapterRegistry";
import type { WorkspaceCloseInput } from "../domains/workspaceDomainTable";
import { collectWorkspaceImpacts } from "./workspaceImpacts";

function input(
  overrides: Partial<WorkspaceCloseInput> = {},
): WorkspaceCloseInput {
  return { title: "t", isDirty: false, isRunning: false, ...overrides };
}

function adapterWith(describe: unknown): WorkspaceContentAdapter<any> {
  return {
    lifecycle: { describeDisposalImpact: describe },
  } as unknown as WorkspaceContentAdapter<any>;
}

describe("collectWorkspaceImpacts", () => {
  it("uses the adapter description when the adapter declares one", () => {
    const describe = vi.fn((_input: WorkspaceCloseInput) => [
      { kind: "dirtyFile" as const, title: "custom" },
    ]);
    const sources = [
      {
        input: input({ title: "a.txt", isDirty: true }),
        adapter: adapterWith(describe),
      },
    ];

    expect(collectWorkspaceImpacts({ sources })).toEqual([
      { kind: "dirtyFile", title: "custom" },
    ]);
    expect(describe).toHaveBeenCalledTimes(1);
    expect(describe.mock.calls[0]?.[0]).toEqual({
      isDirty: true,
      isRunning: false,
      title: "a.txt",
    });
    // 反向：结果里没有适配器未声明时的兜底文案。
    expect(collectWorkspaceImpacts({ sources })).not.toContainEqual(
      expect.objectContaining({ title: "a.txt" }),
    );
  });

  it("falls back to runningPty for running content without an adapter hook", () => {
    const sources = [
      {
        input: input({ title: "claude", isRunning: true }),
        adapter: undefined,
      },
      {
        input: input({ title: "codex", isRunning: true }),
        adapter: { lifecycle: {} } as never,
      },
    ];

    expect(collectWorkspaceImpacts({ sources })).toEqual([
      { kind: "runningPty", title: "claude" },
      { kind: "runningPty", title: "codex" },
    ]);
  });

  it("an adapter that returns an empty list suppresses the fallback", () => {
    const sources = [
      {
        input: input({ title: "a.txt", isDirty: true, isRunning: true }),
        adapter: adapterWith(() => []),
      },
    ];

    expect(collectWorkspaceImpacts({ sources })).toEqual([]);
    // 反向：没有适配器时运行中优先于脏。
    expect(
      collectWorkspaceImpacts({
        sources: [
          {
            input: input({ title: "a.txt", isDirty: true, isRunning: true }),
            adapter: undefined,
          },
        ],
      }),
    ).toEqual([{ kind: "runningPty", title: "a.txt" }]);
  });

  it("falls back to dirtyFile for dirty content and to nothing for clean content", () => {
    const sources = [
      {
        input: input({ title: "dirty.txt", isDirty: true }),
        adapter: undefined,
      },
      { input: input({ title: "clean.txt" }), adapter: undefined },
    ];

    expect(collectWorkspaceImpacts({ sources })).toEqual([
      { kind: "dirtyFile", title: "dirty.txt" },
    ]);
  });

  it("flattens the impacts of several sources in order", () => {
    const sources = [
      { input: input({ title: "p", isRunning: true }), adapter: undefined },
      { input: input({ title: "f", isDirty: true }), adapter: undefined },
      { input: input({ title: "c" }), adapter: undefined },
    ];

    expect(collectWorkspaceImpacts({ sources })).toEqual([
      { kind: "runningPty", title: "p" },
      { kind: "dirtyFile", title: "f" },
    ]);
    expect(collectWorkspaceImpacts({ sources: [] })).toEqual([]);
  });
});

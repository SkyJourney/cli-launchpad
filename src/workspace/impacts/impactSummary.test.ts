import { describe, expect, it } from "vitest";
import {
  hasImpacts,
  summarizeDisposalImpacts,
  summarizeExitImpacts,
} from "./impactSummary";
import { shouldExitWithoutPrompt } from "../../lib/appExitImpacts";
import type { WorkspaceContentDisposalImpact } from "../../lib/workspaceContentClose";

const empty = {
  runningPtys: { count: 0, titles: [] as string[] },
  dirtyFiles: [] as Array<{ key: string; title: string }>,
  executionTaskCount: 0,
};

describe("ImpactSummary", () => {
  it("reports impacts when any of the three counters is positive", () => {
    expect(hasImpacts(empty)).toBe(false);
    expect(
      hasImpacts({ ...empty, runningPtys: { count: 1, titles: [] } }),
    ).toBe(true);
    expect(
      hasImpacts({ ...empty, dirtyFiles: [{ key: "d1", title: "a.txt" }] }),
    ).toBe(true);
    expect(hasImpacts({ ...empty, executionTaskCount: 1 })).toBe(true);
  });

  it("builds the close-path summary with the existing React key scheme", () => {
    const impacts: WorkspaceContentDisposalImpact[] = [
      { kind: "runningPty", title: "Claude" },
      { kind: "dirtyFile", title: "a.txt" },
      { kind: "runningPty", title: "Codex" },
    ];
    expect(summarizeDisposalImpacts(impacts)).toEqual({
      runningPtys: { count: 2, titles: ["Claude", "Codex"] },
      dirtyFiles: [{ key: "file:a.txt", title: "a.txt" }],
      executionTaskCount: 0,
    });
    expect(summarizeDisposalImpacts([])).toEqual(empty);
  });

  it("builds the exit-path summary from Rust counts and the collected dirty files", () => {
    expect(
      summarizeExitImpacts({
        ptyCount: 2,
        executionTaskCount: 3,
        dirtyFiles: [{ documentId: "d1", relativePath: "a.txt" }],
      }),
    ).toEqual({
      runningPtys: { count: 2, titles: [] },
      dirtyFiles: [{ key: "d1", title: "a.txt" }],
      executionTaskCount: 3,
    });
  });

  it("clamps negative counts to zero", () => {
    const summary = summarizeExitImpacts({
      ptyCount: -1,
      executionTaskCount: -5,
      dirtyFiles: [],
    });
    expect(summary.runningPtys.count).toBe(0);
    expect(summary.executionTaskCount).toBe(0);
    expect(hasImpacts(summary)).toBe(false);
  });

  it("decides whether to prompt exactly like the close batch does for the same impacts", () => {
    const groups: WorkspaceContentDisposalImpact[][] = [
      [],
      [{ kind: "runningPty", title: "Claude" }],
      [{ kind: "dirtyFile", title: "a.txt" }],
      [
        { kind: "runningPty", title: "Claude" },
        { kind: "dirtyFile", title: "a.txt" },
      ],
    ];
    for (const impacts of groups) {
      expect(hasImpacts(summarizeDisposalImpacts(impacts))).toBe(
        impacts.length > 0,
      );
    }
    const exitCases = [
      { ptyCount: 0, executionTaskCount: 0, dirtyFiles: [] },
      { ptyCount: 1, executionTaskCount: 0, dirtyFiles: [] },
      { ptyCount: 0, executionTaskCount: 1, dirtyFiles: [] },
      {
        ptyCount: 0,
        executionTaskCount: 0,
        dirtyFiles: [{ documentId: "d1", relativePath: "a.txt" }],
      },
    ];
    for (const exitCase of exitCases) {
      expect(
        shouldExitWithoutPrompt({
          ...exitCase,
          ptyCount: exitCase.ptyCount,
          dirtyFiles: exitCase.dirtyFiles,
        }),
      ).toBe(!hasImpacts(summarizeExitImpacts(exitCase)));
    }
  });
});

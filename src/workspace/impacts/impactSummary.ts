import { hasExitImpacts } from "../../lib/appExitImpacts";
import type { WorkspaceContentDisposalImpact } from "../../lib/workspaceContentClose";

/**
 * The impact data shared by the exit dialog and the close dialog (m6-095). Both dialogs read the
 * same shape and decide whether to prompt through `hasImpacts`.
 */
export interface ImpactSummary {
  runningPtys: { count: number; titles: string[] };
  dirtyFiles: Array<{ key: string; title: string }>;
  executionTaskCount: number;
}

export function hasImpacts(summary: ImpactSummary): boolean {
  return hasExitImpacts({
    ptyCount: summary.runningPtys.count,
    dirtyFileCount: summary.dirtyFiles.length,
    executionTaskCount: summary.executionTaskCount,
  });
}

function clampCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/** Exit path: the running PTY count and the execution task count come from Rust. */
export function summarizeExitImpacts(args: {
  ptyCount: number;
  executionTaskCount: number;
  dirtyFiles: ReadonlyArray<{ documentId: string; relativePath: string }>;
}): ImpactSummary {
  return {
    runningPtys: { count: clampCount(args.ptyCount), titles: [] },
    dirtyFiles: args.dirtyFiles.map((file) => ({
      key: file.documentId,
      title: file.relativePath,
    })),
    executionTaskCount: clampCount(args.executionTaskCount),
  };
}

/** Close path: the impacts of a batch close, keyed the way the close dialog always keyed them. */
export function summarizeDisposalImpacts(
  impacts: readonly WorkspaceContentDisposalImpact[],
): ImpactSummary {
  const titles = impacts
    .filter((impact) => impact.kind === "runningPty")
    .map((impact) => impact.title);
  const dirtyFiles = impacts
    .filter((impact) => impact.kind === "dirtyFile")
    .map((impact) => ({ key: `file:${impact.title}`, title: impact.title }));
  return {
    runningPtys: { count: titles.length, titles },
    dirtyFiles,
    executionTaskCount: 0,
  };
}

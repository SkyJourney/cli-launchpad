import type { WorkspaceContentAdapter } from "../../components/workspaceContentAdapterRegistry";
import type { WorkspaceContentDisposalImpact } from "../../lib/workspaceContentClose";
import type { WorkspaceCloseInput } from "../domains/workspaceDomainTable";

export interface WorkspaceImpactSource {
  input: WorkspaceCloseInput;
  adapter: WorkspaceContentAdapter<any> | undefined;
}

export interface WorkspaceImpactScope {
  sources: readonly WorkspaceImpactSource[];
}

/**
 * Close-path impact summary. The adapter's describeDisposalImpact wins when it
 * exists (even if it returns an empty list); otherwise running content is a
 * runningPty impact and dirty content is a dirtyFile impact.
 */
export function collectWorkspaceImpacts(
  scope: WorkspaceImpactScope,
): WorkspaceContentDisposalImpact[] {
  return scope.sources.flatMap(({ input, adapter }) => {
    const described = adapter?.lifecycle?.describeDisposalImpact?.({
      isDirty: input.isDirty,
      isRunning: input.isRunning,
      title: input.title,
    });
    // 与 HEAD 的 ?? 兜底一致：返回 null 或 undefined 时才回退，空数组仍是结论。
    if (described != null) return described;
    if (input.isRunning) return [{ kind: "runningPty", title: input.title }];
    if (input.isDirty) return [{ kind: "dirtyFile", title: input.title }];
    return [];
  });
}

import { useCallback } from "react";
import { toast } from "sonner";
import { tryGetWorkspaceContentAdapter } from "../../components/WorkspaceContentView";
import {
  hasWorkspaceContent,
  listWorkspacePanes,
} from "../../lib/ptyWorkspaceLayout";
import { reduceWorkspaceTree } from "../../lib/workspaceContentCommand";
import {
  closeWorkspaceContentBatch,
  shouldCloseWorkspaceContent,
  type WorkspaceContentDisposalImpact,
} from "../../lib/workspaceContentClose";
import { workspaceContentKey } from "../../lib/workspaceContentKey";
import type { WorkspacePaneContentRef } from "../../lib/tauri";
import {
  workspaceDomainKinds,
  getWorkspaceDomain,
} from "../domains/workspaceDomainTable";
import { collectWorkspaceImpacts } from "../impacts/workspaceImpacts";
import type { WorkspaceRuntime } from "./useWorkspaceRuntime";

/** 关闭内容的批量流程：确认影响、逐领域关闭并汇总 pending 与失败提示（逐字取自宿主）。 */
export function useCloseContents({
  store,
  contentCoordinatorRef,
  closeConfirmation,
  domainTable,
  commitTree,
  tRef,
}: Pick<
  WorkspaceRuntime,
  | "store"
  | "contentCoordinatorRef"
  | "closeConfirmation"
  | "domainTable"
  | "commitTree"
  | "tRef"
>) {
  const closeContents = useCallback(
    async (
      requestedContents: WorkspacePaneContentRef[],
      origin: "tab" | "menu" | "stack" | "window",
      onApproved?: () => void,
    ) => {
      const uniqueContents: WorkspacePaneContentRef[] = [
        ...new Map(
          requestedContents.map((content) => [
            workspaceContentKey(content),
            content,
          ]),
        ).values(),
      ];
      type WorkspaceCloseTarget = {
        content: WorkspacePaneContentRef;
        beforeClose: () => boolean;
        describeDisposalImpact: () => WorkspaceContentDisposalImpact[];
      };
      const closeTargets: WorkspaceCloseTarget[] = [];
      for (const content of uniqueContents) {
        const pane = listWorkspacePanes(store.getLive().tree).find(
          (candidate) => hasWorkspaceContent(candidate, content),
        );
        if (!pane) continue;

        if (content.kind === "unknown") {
          closeTargets.push({
            content,
            beforeClose: () => true,
            describeDisposalImpact: () => [],
          });
          continue;
        }

        const domain = getWorkspaceDomain(domainTable, content.kind);
        const input = domain?.closeInput(content);
        if (!domain || !input) continue;
        const adapter = tryGetWorkspaceContentAdapter(content.kind);
        contentCoordinatorRef.current.ensureAttached(content, {
          kind: "pane",
          windowLabel: "main",
          paneId: pane.id,
        });
        closeTargets.push({
          content,
          beforeClose: () =>
            shouldCloseWorkspaceContent(adapter?.lifecycle?.beforeClose, {
              isDirty: input.isDirty,
              confirmDiscard: () => false,
            }),
          describeDisposalImpact: () =>
            collectWorkspaceImpacts({ sources: [{ input, adapter }] }),
        });
      }
      if (closeTargets.length === 0) return;

      let pendingCount = 0;
      let failedCount = 0;
      try {
        await closeWorkspaceContentBatch({
          coordinator: contentCoordinatorRef.current,
          requestId: crypto.randomUUID(),
          requests: closeTargets,
          confirmImpacts: closeConfirmation.confirm,
          onApproved,
          dispose: (context) => {
            if (context.content.kind === "unknown") return;
            return tryGetWorkspaceContentAdapter(
              context.content.kind,
            )?.lifecycle?.dispose?.(context as never);
          },
          execute: async () => {
            const closedContents: WorkspacePaneContentRef[] = [];
            const pendingContents: WorkspacePaneContentRef[] = [];
            const unsupportedContents = closeTargets.flatMap((target) =>
              target.content.kind === "unknown" ? [target.content] : [],
            );
            if (unsupportedContents.length > 0) {
              commitTree(
                unsupportedContents.reduce(
                  (next, content) =>
                    reduceWorkspaceTree(next, {
                      type: "close",
                      refs: [content],
                      origin,
                    }),
                  store.getLive().tree,
                ),
              );
              closedContents.push(...unsupportedContents);
            }
            for (const kind of workspaceDomainKinds(domainTable)) {
              const refs = closeTargets.flatMap((target) =>
                target.content.kind === kind ? [target.content] : [],
              );
              if (refs.length === 0) continue;
              const result = await domainTable[kind].close(
                refs as never,
                origin,
              );
              closedContents.push(...result.closed);
              pendingContents.push(...result.pending);
              failedCount += result.failed.length;
            }
            pendingCount += pendingContents.length;
            return { closed: closedContents, pending: pendingContents };
          },
        });
      } catch (reason) {
        console.error(
          `Failed to close workspace contents from ${origin}`,
          reason,
        );
      }

      if (pendingCount > 0) {
        toast.info(tRef.current("pty.closePending", { count: pendingCount }));
      }
      if (failedCount > 0) {
        toast.error(
          tRef.current("pty.closeFailedMany", { count: failedCount }),
        );
      }
    },
    [commitTree, closeConfirmation.confirm, domainTable, store],
  );
  return closeContents;
}

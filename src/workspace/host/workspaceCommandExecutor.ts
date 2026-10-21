import {
  addWorkspaceContentToPane,
  findWorkspacePane,
  hasWorkspaceContent,
  listWorkspacePanes,
  removeEmptyWorkspacePane,
  splitWorkspacePane,
  type SplitDirection,
} from "../../lib/ptyWorkspaceLayout";
import type { PtyWorkspaceSlot } from "../../components/WorkspacePtySessionRegistry";
import type { WorkspacePaneContentRef } from "../../lib/tauri";
import {
  planWorkspaceReturn,
  reduceWorkspaceTree,
} from "../../lib/workspaceContentCommand";
import {
  isWorkspaceApplyStateCurrent,
  type WorkspaceApplyStateVersion,
} from "../../lib/workspaceLayoutPersistence";
import type { WorkspaceContentCoordinator } from "../../lib/workspaceContentCoordinator";
import { canChangeWorkspaceContentPane } from "../../lib/workspaceContentLifecycle";
import type { HostSnapshot, WorkspaceHostStore } from "./workspaceHostStore";
import {
  type ManagedContentRef,
  ptyContentRef,
} from "../../lib/workspaceContentKey";

export type HostCommand =
  | { type: "focus"; paneId: string }
  | { type: "activate"; ref: WorkspacePaneContentRef; paneId: string }
  | {
      type: "move";
      ref: WorkspacePaneContentRef;
      fromPaneId: string;
      toPaneId: string;
    }
  | {
      type: "split";
      ref: WorkspacePaneContentRef;
      fromPaneId: string;
      direction: SplitDirection;
    }
  | { type: "splitPane"; paneId: string; direction: SplitDirection }
  | { type: "place"; ref: ManagedContentRef }
  | { type: "launch"; slot: PtyWorkspaceSlot }
  | { type: "closeEmptyPane"; paneId: string }
  | {
      type: "completeDetach";
      ref: ManagedContentRef;
      token: string;
      windowToken: string;
    }
  | {
      type: "completeReturn";
      ref: ManagedContentRef;
      token: string;
      requestedPaneId?: string | null;
      /** 调用方记录的目标 pane（beginReturn 时的协调器记录）；计算出的焦点不同则 `pane-mismatch`，不提交。 */
      expectedPaneId?: string;
      whenAlreadyInTree: "activate" | "relocate";
    }
  | {
      type: "recognizeForeignOwner";
      ref: ManagedContentRef;
      token: string;
      ownerWindowLabel: string;
    }
  | { type: "reclaim"; ref: ManagedContentRef }
  | {
      type: "applyPreset";
      expected: WorkspaceApplyStateVersion;
      next: Pick<
        HostSnapshot,
        "tree" | "slots" | "documents" | "focusedPaneId"
      >;
    };

export type CommandIgnoredReason =
  | "restore-in-progress"
  | "unknown-content"
  | "pane-missing"
  | "content-not-in-pane"
  | "same-pane"
  | "owner-not-pane"
  | "no-change"
  | "pane-not-empty"
  | "handoff-not-current"
  | "no-target-pane"
  | "pane-mismatch"
  | "state-changed";

export type CommandOutcome =
  | { status: "applied"; focusPaneId: string }
  | { status: "ignored"; reason: CommandIgnoredReason };

export interface WorkspaceCommandExecutorDeps {
  store: WorkspaceHostStore;
  coordinator: WorkspaceContentCoordinator;
  addSlot: (live: HostSnapshot, slot: PtyWorkspaceSlot) => HostSnapshot;
  isRestoreInProgress: () => boolean;
  /** Runs after the store commit (the host syncs the project context here). */
  afterCommit: (ref: WorkspacePaneContentRef) => void;
  newId: () => string;
  /** Present only when the host has an explicit persistence trigger. */
  schedulePersist?: () => void;
  /** m6-115：每次有效提交之后调用一次，用于显式加载活动文件（替代渲染期的自动加载）。 */
  afterEffectiveCommit?: () => void;
}

export interface WorkspaceCommandExecutor {
  execute: (command: HostCommand) => CommandOutcome;
}

const mainPane = (paneId: string) =>
  ({ kind: "pane", windowLabel: "main", paneId }) as const;

export function createWorkspaceCommandExecutor(
  deps: WorkspaceCommandExecutorDeps,
): WorkspaceCommandExecutor {
  const { store, coordinator } = deps;

  const ignored = (reason: CommandIgnoredReason): CommandOutcome => ({
    status: "ignored",
    reason,
  });

  /** Steps 5 to 7 of the pipeline: one commit, persistence, after effect. */
  const finish = (
    type: string,
    focusPaneId: string,
    afterRef: WorkspacePaneContentRef | null | undefined,
    update: (live: HostSnapshot) => HostSnapshot,
  ): CommandOutcome => {
    const before = store.commitCount;
    store.commit(update, `command:${type}`);
    if (store.commitCount !== before) {
      deps.schedulePersist?.();
      deps.afterEffectiveCommit?.();
    }
    if (afterRef) deps.afterCommit(afterRef);
    return { status: "applied", focusPaneId };
  };

  const execute = (command: HostCommand): CommandOutcome => {
    const live = store.getLive();
    switch (command.type) {
      case "focus": {
        const pane = findWorkspacePane(live.tree, command.paneId);
        if (!pane) return ignored("pane-missing");
        return finish("focus", command.paneId, pane.activeContent, (l) => ({
          ...l,
          focusedPaneId: command.paneId,
        }));
      }
      case "activate": {
        const tree = reduceWorkspaceTree(live.tree, {
          type: "activate",
          ref: command.ref,
          paneId: command.paneId,
        });
        return finish(
          "activate",
          command.paneId,
          command.ref.kind === "unknown" ? null : command.ref,
          (l) => ({ ...l, tree, focusedPaneId: command.paneId }),
        );
      }
      case "move": {
        if (command.ref.kind === "unknown") return ignored("unknown-content");
        const source = findWorkspacePane(live.tree, command.fromPaneId);
        const destination = findWorkspacePane(live.tree, command.toPaneId);
        if (!source || !destination) return ignored("pane-missing");
        if (!hasWorkspaceContent(source, command.ref)) {
          return ignored("content-not-in-pane");
        }
        if (command.fromPaneId === command.toPaneId)
          return ignored("same-pane");
        const ownerState = coordinator.ensureAttached(
          command.ref,
          mainPane(source.id),
        );
        if (!canChangeWorkspaceContentPane(ownerState)) {
          return ignored("owner-not-pane");
        }
        const next = reduceWorkspaceTree(live.tree, {
          type: "move",
          ref: command.ref,
          toPaneId: command.toPaneId,
        });
        if (next === live.tree) return ignored("no-change");
        coordinator.ensureAttached(command.ref, mainPane(command.toPaneId));
        return finish("move", command.toPaneId, command.ref, (l) => ({
          ...l,
          tree: next,
          focusedPaneId: command.toPaneId,
        }));
      }
      case "split": {
        if (command.ref.kind === "unknown") return ignored("unknown-content");
        const source = findWorkspacePane(live.tree, command.fromPaneId);
        if (!source) return ignored("pane-missing");
        if (!hasWorkspaceContent(source, command.ref)) {
          return ignored("content-not-in-pane");
        }
        const ownerState = coordinator.ensureAttached(
          command.ref,
          mainPane(source.id),
        );
        if (!canChangeWorkspaceContentPane(ownerState)) {
          return ignored("owner-not-pane");
        }
        const newPaneId = deps.newId();
        const next = reduceWorkspaceTree(live.tree, {
          type: "split",
          ref: command.ref,
          toPaneId: newPaneId,
          direction: command.direction,
          splitId: deps.newId(),
        });
        if (next === live.tree) return ignored("no-change");
        coordinator.ensureAttached(command.ref, mainPane(newPaneId));
        return finish("split", newPaneId, command.ref, (l) => ({
          ...l,
          tree: next,
          focusedPaneId: newPaneId,
        }));
      }
      case "splitPane": {
        const source = findWorkspacePane(live.tree, command.paneId);
        if (!source) return ignored("pane-missing");
        const newPaneId = deps.newId();
        const next = splitWorkspacePane(
          live.tree,
          command.paneId,
          command.direction,
          deps.newId(),
          newPaneId,
        );
        return finish("splitPane", newPaneId, source.activeContent, (l) => ({
          ...l,
          tree: next,
          focusedPaneId: newPaneId,
        }));
      }
      case "place": {
        const panes = listWorkspacePanes(live.tree);
        const pane =
          panes.find((candidate) =>
            hasWorkspaceContent(candidate, command.ref),
          ) ??
          panes.find((candidate) => candidate.id === live.focusedPaneId) ??
          panes[0];
        const next = hasWorkspaceContent(pane, command.ref)
          ? reduceWorkspaceTree(live.tree, {
              type: "activate",
              ref: command.ref,
              paneId: pane.id,
            })
          : addWorkspaceContentToPane(live.tree, pane.id, command.ref);
        coordinator.ensureAttached(command.ref, mainPane(pane.id));
        return finish("place", pane.id, null, (l) => ({
          ...l,
          tree: next,
          focusedPaneId: pane.id,
        }));
      }
      case "launch": {
        if (deps.isRestoreInProgress()) return ignored("restore-in-progress");
        const ref = ptyContentRef(command.slot.instanceId);
        const pane =
          findWorkspacePane(live.tree, live.focusedPaneId) ??
          listWorkspacePanes(live.tree)[0];
        coordinator.ensureAttached(ref, mainPane(pane.id));
        return finish("launch", pane.id, null, (l) => {
          const withSlot = deps.addSlot(l, command.slot);
          return {
            ...withSlot,
            tree: addWorkspaceContentToPane(withSlot.tree, pane.id, ref),
            focusedPaneId: pane.id,
          };
        });
      }
      case "closeEmptyPane": {
        const pane = findWorkspacePane(live.tree, command.paneId);
        if (!pane) return ignored("pane-missing");
        if (pane.contents.length > 0) return ignored("pane-not-empty");
        const next = removeEmptyWorkspacePane(live.tree, command.paneId);
        const focusKept = findWorkspacePane(next, live.focusedPaneId);
        const focusPaneId = focusKept
          ? live.focusedPaneId
          : listWorkspacePanes(next)[0].id;
        const afterRef = focusKept
          ? null
          : findWorkspacePane(next, focusPaneId)?.activeContent;
        return finish("closeEmptyPane", focusPaneId, afterRef, (l) => ({
          ...l,
          tree: next,
          treeRevision: l.treeRevision + 1,
          focusedPaneId: focusPaneId,
        }));
      }
      case "completeDetach": {
        // 树的计算先于握手登记：登记失败时没有任何变更（纯计算不改状态）。
        const next = reduceWorkspaceTree(live.tree, {
          type: "detach",
          ref: command.ref,
        });
        const ownership = coordinator.completeHandoff(
          command.ref,
          "detachReady",
          command.token,
          command.windowToken,
        );
        if (ownership?.outcome !== "changed") {
          return ignored("handoff-not-current");
        }
        const focusPaneId = findWorkspacePane(next, live.focusedPaneId)
          ? live.focusedPaneId
          : listWorkspacePanes(next)[0].id;
        return finish("completeDetach", focusPaneId, null, (l) => ({
          ...l,
          tree: next,
          focusedPaneId: focusPaneId,
        }));
      }
      case "completeReturn": {
        const plan = planWorkspaceReturn(live.tree, {
          ref: command.ref,
          requestedPaneId: command.requestedPaneId,
          focusedPaneId: live.focusedPaneId,
          whenAlreadyInTree: command.whenAlreadyInTree,
        });
        if (!plan) return ignored("no-target-pane");
        if (
          command.expectedPaneId !== undefined &&
          plan.focusPaneId !== command.expectedPaneId
        ) {
          return ignored("pane-mismatch");
        }
        const ownership = coordinator.completeHandoff(
          command.ref,
          "returnReady",
          command.token,
        );
        if (ownership?.outcome !== "changed") {
          return ignored("handoff-not-current");
        }
        return finish("completeReturn", plan.focusPaneId, null, (l) => ({
          ...l,
          tree: plan.nextTree,
          focusedPaneId: plan.focusPaneId,
        }));
      }
      case "recognizeForeignOwner": {
        // 与 completeDetach 相同的纯计算与焦点回退；登记的归属是外来窗口而不是本次创建的子窗口。
        const next = reduceWorkspaceTree(live.tree, {
          type: "detach",
          ref: command.ref,
        });
        const ownership = coordinator.recognizeForeignOwner(
          command.ref,
          command.token,
          command.ownerWindowLabel,
        );
        if (ownership?.outcome !== "changed") {
          return ignored("handoff-not-current");
        }
        const focusPaneId = findWorkspacePane(next, live.focusedPaneId)
          ? live.focusedPaneId
          : listWorkspacePanes(next)[0].id;
        return finish("recognizeForeignOwner", focusPaneId, null, (l) => ({
          ...l,
          tree: next,
          focusedPaneId: focusPaneId,
        }));
      }
      case "reclaim": {
        // 目标：已含该内容的 pane，否则焦点 pane，否则第一个 pane（与 planWorkspaceReturn 的回退顺序一致）。
        const panes = listWorkspacePanes(live.tree);
        const existing = panes.find((pane) =>
          hasWorkspaceContent(pane, command.ref),
        );
        const target =
          existing ??
          findWorkspacePane(live.tree, live.focusedPaneId) ??
          panes[0];
        if (!target) return ignored("no-target-pane");
        const next = reduceWorkspaceTree(
          live.tree,
          existing
            ? { type: "activate", ref: command.ref, paneId: existing.id }
            : { type: "return", ref: command.ref, toPaneId: target.id },
        );
        coordinator.ownerEnded(command.ref);
        coordinator.ensureAttached(command.ref, mainPane(target.id));
        const focusPaneId = existing?.id ?? target.id;
        return finish("reclaim", focusPaneId, null, (l) => ({
          ...l,
          tree: next,
          focusedPaneId: focusPaneId,
        }));
      }
      case "applyPreset": {
        // 陈旧检查先于任何登记：状态已变化时 coordinator 与树都不动。
        // 保护集合与 HEAD 的 captureApplyState 一致：全部窗口持有的内容（含 returning）。
        const current = {
          tree: live.tree,
          slots: live.slots,
          focusedPaneId: live.focusedPaneId,
          detachedContents: coordinator.listWindowOwned(),
        };
        if (!isWorkspaceApplyStateCurrent(command.expected, current)) {
          return ignored("state-changed");
        }
        for (const pane of listWorkspacePanes(command.next.tree)) {
          for (const content of pane.contents) {
            if (content.kind === "unknown") continue;
            coordinator.ensureAttached(content, mainPane(pane.id));
          }
        }
        const { next } = command;
        return finish("applyPreset", next.focusedPaneId, null, (l) => ({
          ...l,
          slots: next.slots,
          documents: next.documents,
          tree: next.tree,
          focusedPaneId: next.focusedPaneId,
        }));
      }
    }
  };

  return { execute };
}

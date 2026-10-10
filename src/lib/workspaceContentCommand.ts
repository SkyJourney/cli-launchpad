import type { WorkspacePaneContentRef } from "./tauri";
import {
  activateWorkspaceContent,
  findWorkspacePane,
  hasWorkspaceContent,
  listWorkspacePanes,
  moveWorkspaceContent,
  placeContentExclusively,
  removeWorkspaceContentFromTree,
  splitAndMoveWorkspaceContent,
  type SplitDirection,
  type WorkspaceNode,
} from "./ptyWorkspaceLayout";

export type WorkspaceContentCommand =
  | {
      type: "activate";
      ref: WorkspacePaneContentRef;
      paneId: string;
    }
  | {
      type: "close";
      refs: WorkspacePaneContentRef[];
      origin: "tab" | "menu" | "stack" | "window";
    }
  | {
      type: "move";
      ref: WorkspacePaneContentRef;
      toPaneId: string;
      index?: number;
    }
  | {
      type: "split";
      ref: WorkspacePaneContentRef;
      toPaneId: string;
      direction: SplitDirection;
      splitId: string;
    }
  | { type: "detach"; ref: WorkspacePaneContentRef }
  | {
      type: "return";
      ref: WorkspacePaneContentRef;
      toPaneId?: string;
    };

/**
 * Pure reducer that applies pane topology changes (activate, close, move,
 * split, detach, return) to a workspace tree without branching on content
 * kind. It is NOT a command executor: it never touches the coordinator,
 * adapters or domain operations; callers decide the commit order.
 */
export function reduceWorkspaceTree(
  tree: WorkspaceNode,
  command: WorkspaceContentCommand,
): WorkspaceNode {
  switch (command.type) {
    case "activate":
      return activateWorkspaceContent(tree, command.paneId, command.ref);
    case "close":
      return command.refs.reduce(
        (next, content) => removeWorkspaceContentFromTree(next, content),
        tree,
      );
    case "move": {
      if (command.ref.kind === "unknown") return tree;
      const source = listWorkspacePanes(tree).find((pane) =>
        hasWorkspaceContent(pane, command.ref),
      );
      if (!source || !findWorkspacePane(tree, command.toPaneId)) return tree;
      const moved = moveWorkspaceContent(
        tree,
        source.id,
        command.toPaneId,
        command.ref,
      );
      return command.index === undefined || moved === tree
        ? moved
        : placeContentExclusively(
            moved,
            command.toPaneId,
            command.ref,
            command.index,
          );
    }
    case "split": {
      if (command.ref.kind === "unknown") return tree;
      const source = listWorkspacePanes(tree).find((pane) =>
        hasWorkspaceContent(pane, command.ref),
      );
      if (!source) return tree;
      return splitAndMoveWorkspaceContent(
        tree,
        source.id,
        command.ref,
        command.direction,
        command.splitId,
        command.toPaneId,
      );
    }
    case "detach":
      if (command.ref.kind === "unknown") return tree;
      return removeWorkspaceContentFromTree(tree, command.ref);
    case "return": {
      if (command.ref.kind === "unknown") return tree;
      const destination = command.toPaneId ?? listWorkspacePanes(tree)[0]?.id;
      if (!destination || !findWorkspacePane(tree, destination)) {
        throw new Error("Workspace has no pane to receive returned content");
      }
      return placeContentExclusively(tree, destination, command.ref);
    }
  }
}

export interface WorkspaceReturnPlan {
  nextTree: WorkspaceNode;
  focusPaneId: string;
}

/**
 * Decides where returning content lands in the given (latest) tree.
 * Callers must pass `treeRef.current` read after every await of the return
 * pipeline, then commit the coordinator and the tree without awaiting.
 */
export function planWorkspaceReturn(
  tree: WorkspaceNode,
  args: {
    ref: WorkspacePaneContentRef;
    requestedPaneId?: string | null;
    focusedPaneId: string;
    whenAlreadyInTree: "activate" | "relocate";
  },
): WorkspaceReturnPlan | null {
  if (args.ref.kind === "unknown") return null;
  const panes = listWorkspacePanes(tree);
  const existing = panes.find((pane) => hasWorkspaceContent(pane, args.ref));
  if (existing && args.whenAlreadyInTree === "activate") {
    return {
      nextTree: reduceWorkspaceTree(tree, {
        type: "activate",
        ref: args.ref,
        paneId: existing.id,
      }),
      focusPaneId: existing.id,
    };
  }
  const target =
    (args.requestedPaneId
      ? findWorkspacePane(tree, args.requestedPaneId)
      : null) ??
    existing ??
    findWorkspacePane(tree, args.focusedPaneId) ??
    panes[0] ??
    null;
  if (!target) return null;
  return {
    nextTree: reduceWorkspaceTree(tree, {
      type: "return",
      ref: args.ref,
      toPaneId: target.id,
    }),
    focusPaneId: target.id,
  };
}

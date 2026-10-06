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

/** Applies shared pane topology changes without branching on content kind. */
export function executeWorkspaceCommand(
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
      return removeWorkspaceContentFromTree(tree, command.ref);
    case "return": {
      const destination = command.toPaneId ?? listWorkspacePanes(tree)[0]?.id;
      if (!destination || !findWorkspacePane(tree, destination)) {
        throw new Error("Workspace has no pane to receive returned content");
      }
      return placeContentExclusively(tree, destination, command.ref);
    }
  }
}

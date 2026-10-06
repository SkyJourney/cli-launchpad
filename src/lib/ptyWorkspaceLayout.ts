export type SplitDirection = "horizontal" | "vertical";

import type { WorkspacePaneContentRef } from "./tauri";

export interface WorkspacePane {
  kind: "pane";
  id: string;
  paneNumber: number;
  contents: WorkspacePaneContentRef[];
  activeContent?: WorkspacePaneContentRef | null;
}

export interface WorkspaceSplit {
  kind: "split";
  id: string;
  direction: SplitDirection;
  ratio: number;
  first: WorkspaceNode;
  second: WorkspaceNode;
}

export type WorkspaceNode = WorkspacePane | WorkspaceSplit;

export interface WorkspaceSlotSequence {
  directoryId: number;
  toolKey: string;
  sequence: number;
}

export const MIN_WORKSPACE_PANE_WIDTH = 200;
export const MIN_WORKSPACE_PANE_HEIGHT = 150;
export const WORKSPACE_SASH_SIZE = 8;

export function nextWorkspaceSessionSequence(
  slots: readonly WorkspaceSlotSequence[],
  directoryId: number,
  toolKey: string,
): number {
  return (
    Math.max(
      0,
      ...slots
        .filter(
          (slot) =>
            slot.directoryId === directoryId && slot.toolKey === toolKey,
        )
        .map((slot) => slot.sequence),
    ) + 1
  );
}

export function minimumWorkspacePaneExtent(direction: SplitDirection): number {
  const minimum =
    direction === "horizontal"
      ? MIN_WORKSPACE_PANE_WIDTH
      : MIN_WORKSPACE_PANE_HEIGHT;
  return minimum * 2 + WORKSPACE_SASH_SIZE;
}

export function workspaceSplitSizes(
  ratio: number,
  extent: number,
): [number, number] {
  const boundedExtent = Number.isFinite(extent) ? Math.max(0, extent) : 0;
  const availableExtent = Math.max(0, boundedExtent - WORKSPACE_SASH_SIZE);
  const first = Math.round(availableExtent * clampSplitRatio(ratio));
  return [first, availableExtent - first];
}

export function isUsableWorkspaceSplitSizes(
  sizes: readonly number[],
): sizes is [number, number] {
  return (
    sizes.length === 2 &&
    Number.isFinite(sizes[0]) &&
    Number.isFinite(sizes[1]) &&
    sizes[0] > 0 &&
    sizes[1] > 0
  );
}

export function canSplitWorkspacePane(
  width: number,
  height: number,
  direction: SplitDirection,
): boolean {
  return direction === "horizontal"
    ? width >= minimumWorkspacePaneExtent(direction)
    : height >= minimumWorkspacePaneExtent(direction);
}

export function createWorkspacePane(id: string, paneNumber = 1): WorkspacePane {
  return {
    kind: "pane",
    id,
    paneNumber,
    contents: [],
    activeContent: null,
  };
}

export function findWorkspacePane(
  node: WorkspaceNode,
  paneId: string,
): WorkspacePane | null {
  if (node.kind === "pane") return node.id === paneId ? node : null;
  return (
    findWorkspacePane(node.first, paneId) ??
    findWorkspacePane(node.second, paneId)
  );
}

export function listWorkspacePanes(node: WorkspaceNode): WorkspacePane[] {
  if (node.kind === "pane") return [node];
  return [
    ...listWorkspacePanes(node.first),
    ...listWorkspacePanes(node.second),
  ];
}

export function listWorkspacePaneContents(
  pane: WorkspacePane,
  kind?: WorkspacePaneContentRef["kind"],
): WorkspacePaneContentRef[] {
  return kind
    ? pane.contents.filter((content) => content.kind === kind)
    : [...pane.contents];
}

export function splitWorkspaceContentSequence<
  T extends {
    content: WorkspacePaneContentRef;
  },
>(
  entries: readonly T[],
  activeContent: WorkspacePaneContentRef | null | undefined,
): { before: T[]; active?: T; after: T[] } {
  const activeIndex = entries.findIndex((entry) =>
    sameWorkspaceContent(entry.content, activeContent),
  );
  if (activeIndex < 0) return { before: [], after: [...entries] };
  return {
    before: entries.slice(0, activeIndex),
    active: entries[activeIndex],
    after: entries.slice(activeIndex + 1),
  };
}

export function workspacePaneOtherContents(
  contents: readonly WorkspacePaneContentRef[],
  target: WorkspacePaneContentRef,
): WorkspacePaneContentRef[] {
  return contents.filter((content) => !sameWorkspaceContent(content, target));
}

export function hasWorkspaceContent(
  pane: WorkspacePane,
  content: WorkspacePaneContentRef,
): boolean {
  return pane.contents.some((candidate) =>
    sameWorkspaceContent(candidate, content),
  );
}

export function listVisibleWorkspaceSessionIds(node: WorkspaceNode): string[] {
  if (node.kind === "pane") {
    return node.activeContent?.kind === "pty" &&
      node.contents.some((content) =>
        sameWorkspaceContent(content, node.activeContent!),
      )
      ? [node.activeContent.slotId]
      : [];
  }
  return [
    ...listVisibleWorkspaceSessionIds(node.first),
    ...listVisibleWorkspaceSessionIds(node.second),
  ];
}

export function containsWorkspaceSession(
  node: WorkspaceNode,
  sessionId: string,
): boolean {
  return node.kind === "pane"
    ? node.contents.some(
        (content) => content.kind === "pty" && content.slotId === sessionId,
      )
    : containsWorkspaceSession(node.first, sessionId) ||
        containsWorkspaceSession(node.second, sessionId);
}

export function splitWorkspacePane(
  node: WorkspaceNode,
  paneId: string,
  direction: SplitDirection,
  splitId: string,
  newPaneId: string,
  newPaneNumber = nextWorkspacePaneNumber(node),
): WorkspaceNode {
  if (node.kind === "pane") {
    if (node.id !== paneId) return node;
    return {
      kind: "split",
      id: splitId,
      direction,
      ratio: 0.5,
      first: node,
      second: createWorkspacePane(newPaneId, newPaneNumber),
    };
  }
  const first = splitWorkspacePane(
    node.first,
    paneId,
    direction,
    splitId,
    newPaneId,
    newPaneNumber,
  );
  if (first !== node.first) return { ...node, first };
  const second = splitWorkspacePane(
    node.second,
    paneId,
    direction,
    splitId,
    newPaneId,
    newPaneNumber,
  );
  return second !== node.second ? { ...node, second } : node;
}

export function addSessionToWorkspacePane(
  node: WorkspaceNode,
  paneId: string,
  sessionId: string,
): WorkspaceNode {
  if (containsWorkspaceSession(node, sessionId)) {
    throw new Error(`PTY session is already assigned to a pane: ${sessionId}`);
  }
  return updateWorkspacePane(node, paneId, (pane) => ({
    ...pane,
    contents: [...pane.contents, { kind: "pty", slotId: sessionId }],
    activeContent: { kind: "pty", slotId: sessionId },
  }));
}

export function activateWorkspaceSession(
  node: WorkspaceNode,
  paneId: string,
  sessionId: string,
): WorkspaceNode {
  return updateWorkspacePane(node, paneId, (pane) => {
    if (
      !pane.contents.some(
        (content) => content.kind === "pty" && content.slotId === sessionId,
      )
    ) {
      throw new Error(`PTY session does not belong to pane: ${sessionId}`);
    }
    return {
      ...pane,
      activeContent: { kind: "pty", slotId: sessionId },
    };
  });
}

export function moveWorkspaceSession(
  node: WorkspaceNode,
  sourcePaneId: string,
  destinationPaneId: string,
  sessionId: string,
): WorkspaceNode {
  const source = findWorkspacePane(node, sourcePaneId);
  if (
    !source?.contents.some(
      (content) => content.kind === "pty" && content.slotId === sessionId,
    )
  ) {
    throw new Error("PTY session does not belong to pane: " + sourcePaneId);
  }
  if (!findWorkspacePane(node, destinationPaneId)) {
    throw new Error("Workspace pane not found: " + destinationPaneId);
  }
  if (sourcePaneId === destinationPaneId) {
    return activateWorkspaceSession(node, sourcePaneId, sessionId);
  }

  const withoutSession = removeWorkspaceContentFromPane(node, sourcePaneId, {
    kind: "pty",
    slotId: sessionId,
  });

  return addSessionToWorkspacePane(
    withoutSession,
    destinationPaneId,
    sessionId,
  );
}

export function splitAndMoveWorkspaceSession(
  node: WorkspaceNode,
  paneId: string,
  sessionId: string,
  direction: SplitDirection,
  splitId: string,
  newPaneId: string,
): WorkspaceNode {
  const pane = findWorkspacePane(node, paneId);
  if (
    !pane?.contents.some(
      (content) => content.kind === "pty" && content.slotId === sessionId,
    )
  ) {
    throw new Error("PTY session does not belong to pane: " + paneId);
  }

  const split = splitWorkspacePane(node, paneId, direction, splitId, newPaneId);
  return moveWorkspaceSession(split, paneId, newPaneId, sessionId);
}

export function setWorkspaceSplitRatio(
  node: WorkspaceNode,
  splitId: string,
  ratio: number,
): WorkspaceNode {
  if (node.kind === "pane") return node;
  if (node.id === splitId) {
    return { ...node, ratio: clampSplitRatio(ratio) };
  }
  const first = setWorkspaceSplitRatio(node.first, splitId, ratio);
  if (first !== node.first) return { ...node, first };
  const second = setWorkspaceSplitRatio(node.second, splitId, ratio);
  return second !== node.second ? { ...node, second } : node;
}

export function removeWorkspaceSession(
  node: WorkspaceNode,
  sessionId: string,
): WorkspaceNode {
  return removeSessionBranch(node, sessionId);
}

export function addWorkspaceFileToPane(
  node: WorkspaceNode,
  paneId: string,
  documentId: string,
): WorkspaceNode {
  return addWorkspaceContentToPane(node, paneId, { kind: "file", documentId });
}

export function activateWorkspaceFile(
  node: WorkspaceNode,
  paneId: string,
  documentId: string,
): WorkspaceNode {
  return updateWorkspacePane(node, paneId, (pane) => {
    if (
      !pane.contents.some(
        (content) =>
          content.kind === "file" && content.documentId === documentId,
      )
    ) {
      throw new Error(`File document does not belong to pane: ${documentId}`);
    }
    return { ...pane, activeContent: { kind: "file", documentId } };
  });
}

export function deactivateWorkspaceFile(
  node: WorkspaceNode,
  paneId: string,
  documentId: string,
): WorkspaceNode {
  return updateWorkspacePane(node, paneId, (pane) => {
    if (
      pane.activeContent?.kind !== "file" ||
      pane.activeContent.documentId !== documentId
    ) {
      return pane;
    }
    const index = pane.contents.findIndex(
      (content) => content.kind === "file" && content.documentId === documentId,
    );
    const nextContent = pane.contents[index + 1] ?? pane.contents[index - 1];
    return {
      ...pane,
      activeContent: nextContent ?? null,
    };
  });
}

export function removeWorkspaceFileFromPane(
  node: WorkspaceNode,
  paneId: string,
  documentId: string,
): WorkspaceNode {
  return removeWorkspaceContentFromPane(node, paneId, {
    kind: "file",
    documentId,
  });
}

export function moveWorkspaceFileToPane(
  node: WorkspaceNode,
  sourcePaneId: string,
  destinationPaneId: string,
  documentId: string,
): WorkspaceNode {
  const source = findWorkspacePane(node, sourcePaneId);
  const destination = findWorkspacePane(node, destinationPaneId);
  if (
    !source?.contents.some(
      (content) => content.kind === "file" && content.documentId === documentId,
    ) ||
    !destination ||
    sourcePaneId === destinationPaneId
  ) {
    return node;
  }
  return placeContentExclusively(node, destinationPaneId, {
    kind: "file",
    documentId,
  });
}

export function splitAndMoveWorkspaceFile(
  node: WorkspaceNode,
  paneId: string,
  documentId: string,
  direction: SplitDirection,
  splitId: string,
  newPaneId: string,
): WorkspaceNode {
  const pane = findWorkspacePane(node, paneId);
  if (
    !pane?.contents.some(
      (content) => content.kind === "file" && content.documentId === documentId,
    )
  ) {
    throw new Error("File document does not belong to pane: " + paneId);
  }
  const split = splitWorkspacePane(node, paneId, direction, splitId, newPaneId);
  return moveWorkspaceFileToPane(split, paneId, newPaneId, documentId);
}

export function remapWorkspaceFileIds(
  node: WorkspaceNode,
  idMap: ReadonlyMap<string, string>,
): WorkspaceNode {
  if (node.kind === "pane") {
    const contents = node.contents.reduce<WorkspacePaneContentRef[]>(
      (result, content) => {
        const mapped =
          content.kind === "file"
            ? {
                ...content,
                documentId: idMap.get(content.documentId) ?? content.documentId,
              }
            : content;
        if (
          !result.some((candidate) => sameWorkspaceContent(candidate, mapped))
        ) {
          result.push(mapped);
        }
        return result;
      },
      [],
    );
    const activeContent =
      node.activeContent?.kind === "file"
        ? {
            ...node.activeContent,
            documentId:
              idMap.get(node.activeContent.documentId) ??
              node.activeContent.documentId,
          }
        : node.activeContent;
    return { ...node, contents, activeContent };
  }
  const first = remapWorkspaceFileIds(node.first, idMap);
  const second = remapWorkspaceFileIds(node.second, idMap);
  return first === node.first && second === node.second
    ? node
    : { ...node, first, second };
}

export function removeEmptyWorkspacePane(
  node: WorkspaceNode,
  paneId: string,
): WorkspaceNode {
  const pane = findWorkspacePane(node, paneId);
  if (!pane) {
    throw new Error(`Workspace pane not found: ${paneId}`);
  }
  const next = removeEmptyPaneBranch(node, paneId);
  if (next === undefined) {
    throw new Error(`Workspace pane not found: ${paneId}`);
  }
  if (next) return next;
  return createWorkspacePane(paneId, pane.paneNumber);
}

function nextWorkspacePaneNumber(node: WorkspaceNode): number {
  const usedNumbers = new Set(
    listWorkspacePanes(node).map((pane) => pane.paneNumber),
  );
  let number = 1;
  while (usedNumbers.has(number)) number += 1;
  return number;
}

export function clampSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(0.95, Math.max(0.05, ratio));
}

export function addWorkspaceContentToPane(
  node: WorkspaceNode,
  paneId: string,
  content: WorkspacePaneContentRef,
): WorkspaceNode {
  return updateWorkspacePane(node, paneId, (pane) => {
    if (
      pane.contents.some((candidate) =>
        sameWorkspaceContent(candidate, content),
      )
    ) {
      return { ...pane, activeContent: content };
    }
    return {
      ...pane,
      contents: [...pane.contents, content],
      activeContent: content,
    };
  });
}

export function removeWorkspaceContentFromTree(
  node: WorkspaceNode,
  content: WorkspacePaneContentRef,
): WorkspaceNode {
  if (node.kind === "pane") {
    const activeIndex = node.contents.findIndex((candidate) =>
      sameWorkspaceContent(candidate, node.activeContent),
    );
    const activeWasRemoved = sameWorkspaceContent(node.activeContent, content);
    const replacementIndex =
      activeIndex < 0
        ? 0
        : node.contents
            .slice(0, activeIndex)
            .filter((candidate) => !sameWorkspaceContent(candidate, content))
            .length;
    const contents = node.contents.filter(
      (candidate) => !sameWorkspaceContent(candidate, content),
    );
    if (contents.length === node.contents.length) return node;
    const activeContent = activeWasRemoved
      ? (contents[replacementIndex] ?? contents[replacementIndex - 1] ?? null)
      : node.activeContent;
    return { ...node, contents, activeContent };
  }
  const first = removeWorkspaceContentFromTree(node.first, content);
  const second = removeWorkspaceContentFromTree(node.second, content);
  return first === node.first && second === node.second
    ? node
    : { ...node, first, second };
}

export function placeContentExclusively(
  node: WorkspaceNode,
  paneId: string,
  content: WorkspacePaneContentRef,
): WorkspaceNode {
  if (!findWorkspacePane(node, paneId)) {
    throw new Error(`Workspace pane not found: ${paneId}`);
  }
  const withoutContent = removeWorkspaceContentFromTree(node, content);
  return addWorkspaceContentToPane(withoutContent, paneId, content);
}

export function activateWorkspaceContent(
  node: WorkspaceNode,
  paneId: string,
  content: WorkspacePaneContentRef,
): WorkspaceNode {
  return updateWorkspacePane(node, paneId, (pane) => {
    if (
      !pane.contents.some((candidate) =>
        sameWorkspaceContent(candidate, content),
      )
    ) {
      throw new Error("Workspace content does not belong to pane");
    }
    return { ...pane, activeContent: content };
  });
}

export function removeWorkspaceContentFromPane(
  node: WorkspaceNode,
  paneId: string,
  content: WorkspacePaneContentRef,
): WorkspaceNode {
  return updateWorkspacePane(node, paneId, (pane) => {
    const index = pane.contents.findIndex((candidate) =>
      sameWorkspaceContent(candidate, content),
    );
    if (index < 0) return pane;
    const contents = pane.contents.filter(
      (_, candidateIndex) => candidateIndex !== index,
    );
    const activeContent = sameWorkspaceContent(pane.activeContent, content)
      ? (contents[Math.min(index, contents.length - 1)] ?? null)
      : pane.activeContent;
    return { ...pane, contents, activeContent };
  });
}

export function moveWorkspaceContent(
  node: WorkspaceNode,
  sourcePaneId: string,
  destinationPaneId: string,
  content: WorkspacePaneContentRef,
): WorkspaceNode {
  const source = findWorkspacePane(node, sourcePaneId);
  const destination = findWorkspacePane(node, destinationPaneId);
  if (
    !source?.contents.some((candidate) =>
      sameWorkspaceContent(candidate, content),
    ) ||
    !destination
  ) {
    return node;
  }
  if (sourcePaneId === destinationPaneId)
    return activateWorkspaceContent(node, sourcePaneId, content);
  return placeContentExclusively(node, destinationPaneId, content);
}

export function splitAndMoveWorkspaceContent(
  node: WorkspaceNode,
  paneId: string,
  content: WorkspacePaneContentRef,
  direction: SplitDirection,
  splitId: string,
  newPaneId: string,
): WorkspaceNode {
  const pane = findWorkspacePane(node, paneId);
  if (
    !pane?.contents.some((candidate) =>
      sameWorkspaceContent(candidate, content),
    )
  ) {
    throw new Error("Workspace content does not belong to pane: " + paneId);
  }
  return moveWorkspaceContent(
    splitWorkspacePane(node, paneId, direction, splitId, newPaneId),
    paneId,
    newPaneId,
    content,
  );
}

export function sameWorkspaceContent(
  left: WorkspacePaneContentRef | null | undefined,
  right: WorkspacePaneContentRef | null | undefined,
): boolean {
  if (!left || !right || left.kind !== right.kind) return left === right;
  return left.kind === "pty"
    ? left.slotId ===
        (right as Extract<WorkspacePaneContentRef, { kind: "pty" }>).slotId
    : left.documentId ===
        (right as Extract<WorkspacePaneContentRef, { kind: "file" }>)
          .documentId;
}

function updateWorkspacePane(
  node: WorkspaceNode,
  paneId: string,
  update: (pane: WorkspacePane) => WorkspacePane,
): WorkspaceNode {
  if (node.kind === "pane") {
    if (node.id !== paneId) {
      throw new Error(`Workspace pane not found: ${paneId}`);
    }
    return update(node);
  }
  if (findWorkspacePane(node.first, paneId)) {
    const first = updateWorkspacePane(node.first, paneId, update);
    return first === node.first ? node : { ...node, first };
  }
  if (findWorkspacePane(node.second, paneId)) {
    const second = updateWorkspacePane(node.second, paneId, update);
    return second === node.second ? node : { ...node, second };
  }
  throw new Error(`Workspace pane not found: ${paneId}`);
}

function removeSessionBranch(
  node: WorkspaceNode,
  sessionId: string,
): WorkspaceNode {
  if (node.kind === "pane") {
    const target = { kind: "pty", slotId: sessionId } as const;
    const index = node.contents.findIndex((content) =>
      sameWorkspaceContent(content, target),
    );
    if (index < 0) return node;
    const contents = node.contents.filter(
      (_, candidateIndex) => candidateIndex !== index,
    );
    const activeContent = sameWorkspaceContent(node.activeContent, target)
      ? (contents[Math.min(index, contents.length - 1)] ?? null)
      : node.activeContent;
    return { ...node, contents, activeContent };
  }

  const first = removeSessionBranch(node.first, sessionId);
  const second = removeSessionBranch(node.second, sessionId);
  if (first === node.first && second === node.second) return node;
  return { ...node, first, second };
}

function removeEmptyPaneBranch(
  node: WorkspaceNode,
  paneId: string,
): WorkspaceNode | null | undefined {
  if (node.kind === "pane") {
    if (node.id !== paneId) return node;
    if (node.contents.length > 0) {
      throw new Error(
        `Cannot remove a pane that still has sessions: ${paneId}`,
      );
    }
    return null;
  }

  const first = removeEmptyPaneBranch(node.first, paneId);
  if (first === null) return node.second;
  if (first === undefined) {
    const second = removeEmptyPaneBranch(node.second, paneId);
    if (second === null) return node.first;
    if (second === undefined) return undefined;
    return second === node.second ? node : { ...node, second };
  }

  const second = removeEmptyPaneBranch(node.second, paneId);
  if (second === null) return first;
  if (second === undefined) return { ...node, first };
  if (first === node.first && second === node.second) return node;
  return { ...node, first, second };
}

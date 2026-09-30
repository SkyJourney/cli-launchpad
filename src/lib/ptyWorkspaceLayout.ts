export type SplitDirection = "horizontal" | "vertical";

export interface WorkspacePane {
  kind: "pane";
  id: string;
  paneNumber: number;
  sessionIds: string[];
  activeSessionId: string | null;
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

export const MIN_WORKSPACE_PANE_WIDTH = 220;
export const MIN_WORKSPACE_PANE_HEIGHT = 150;
export const WORKSPACE_SASH_SIZE = 8;

export function minimumWorkspacePaneExtent(direction: SplitDirection): number {
  const minimum =
    direction === "horizontal"
      ? MIN_WORKSPACE_PANE_WIDTH
      : MIN_WORKSPACE_PANE_HEIGHT;
  return minimum * 2 + WORKSPACE_SASH_SIZE;
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
    sessionIds: [],
    activeSessionId: null,
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

export function listVisibleWorkspaceSessionIds(node: WorkspaceNode): string[] {
  if (node.kind === "pane") {
    return node.activeSessionId &&
      node.sessionIds.includes(node.activeSessionId)
      ? [node.activeSessionId]
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
    ? node.sessionIds.includes(sessionId)
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
    sessionIds: [...pane.sessionIds, sessionId],
    activeSessionId: sessionId,
  }));
}

export function activateWorkspaceSession(
  node: WorkspaceNode,
  paneId: string,
  sessionId: string,
): WorkspaceNode {
  return updateWorkspacePane(node, paneId, (pane) => {
    if (!pane.sessionIds.includes(sessionId)) {
      throw new Error(`PTY session does not belong to pane: ${sessionId}`);
    }
    return { ...pane, activeSessionId: sessionId };
  });
}

export function moveWorkspaceSession(
  node: WorkspaceNode,
  sourcePaneId: string,
  destinationPaneId: string,
  sessionId: string,
): WorkspaceNode {
  const source = findWorkspacePane(node, sourcePaneId);
  if (!source || !source.sessionIds.includes(sessionId)) {
    throw new Error("PTY session does not belong to pane: " + sourcePaneId);
  }
  if (!findWorkspacePane(node, destinationPaneId)) {
    throw new Error("Workspace pane not found: " + destinationPaneId);
  }
  if (sourcePaneId === destinationPaneId) {
    return activateWorkspaceSession(node, sourcePaneId, sessionId);
  }

  const withoutSession = updateWorkspacePane(node, sourcePaneId, (pane) => {
    const index = pane.sessionIds.indexOf(sessionId);
    const sessionIds = pane.sessionIds.filter((id) => id !== sessionId);
    const activeSessionId =
      pane.activeSessionId === sessionId
        ? (sessionIds[Math.min(index, sessionIds.length - 1)] ?? null)
        : pane.activeSessionId;
    return { ...pane, sessionIds, activeSessionId };
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
  if (!pane || !pane.sessionIds.includes(sessionId)) {
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
  const next = removeSessionBranch(node, sessionId);
  if (next) return next;
  return createWorkspacePane(
    node.kind === "pane" ? node.id : "workspace-root",
    node.kind === "pane" ? node.paneNumber : 1,
  );
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
  const first = findWorkspacePane(node.first, paneId)
    ? updateWorkspacePane(node.first, paneId, update)
    : node.first;
  if (first !== node.first) return { ...node, first };
  const second = findWorkspacePane(node.second, paneId)
    ? updateWorkspacePane(node.second, paneId, update)
    : node.second;
  if (second !== node.second) return { ...node, second };
  throw new Error(`Workspace pane not found: ${paneId}`);
}

function removeSessionBranch(
  node: WorkspaceNode,
  sessionId: string,
): WorkspaceNode | null {
  if (node.kind === "pane") {
    const index = node.sessionIds.indexOf(sessionId);
    if (index < 0) return node;
    const sessionIds = node.sessionIds.filter((id) => id !== sessionId);
    if (sessionIds.length === 0) return null;
    const activeSessionId =
      node.activeSessionId === sessionId
        ? sessionIds[Math.min(index, sessionIds.length - 1)]
        : node.activeSessionId;
    return { ...node, sessionIds, activeSessionId };
  }

  const first = removeSessionBranch(node.first, sessionId);
  const second = removeSessionBranch(node.second, sessionId);
  if (!first) return second;
  if (!second) return first;
  if (first === node.first && second === node.second) return node;
  return { ...node, first, second };
}

function removeEmptyPaneBranch(
  node: WorkspaceNode,
  paneId: string,
): WorkspaceNode | null | undefined {
  if (node.kind === "pane") {
    if (node.id !== paneId) return node;
    if (node.sessionIds.length > 0) {
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

export type ProjectOrderEntry = {
  id: number;
  pinned: boolean;
};

export type ProjectDropPosition = "before" | "after";

export function moveProjectWithinPinGroup(
  projects: readonly ProjectOrderEntry[],
  draggedId: number,
  targetId: number,
  position: ProjectDropPosition,
): number[] | null {
  if (draggedId === targetId) return null;

  const dragged = projects.find((project) => project.id === draggedId);
  const target = projects.find((project) => project.id === targetId);
  if (!dragged || !target || dragged.pinned !== target.pinned) return null;

  const orderedIds = projects
    .filter((project) => project.pinned === dragged.pinned)
    .map((project) => project.id);
  const draggedIndex = orderedIds.indexOf(draggedId);
  orderedIds.splice(draggedIndex, 1);

  const targetIndex = orderedIds.indexOf(targetId);
  const insertionIndex = targetIndex + (position === "after" ? 1 : 0);
  orderedIds.splice(insertionIndex, 0, draggedId);
  return orderedIds;
}

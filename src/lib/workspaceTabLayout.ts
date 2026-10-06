export interface VisibleWorkspaceTabs {
  visible: number[];
  stacked: number[];
}

export function partitionVisibleTabs(
  widths: number[],
  availableWidth: number,
  activeIndex: number,
  stackTriggerWidth: number,
): VisibleWorkspaceTabs {
  if (widths.length === 0) return { visible: [], stacked: [] };

  const active = Math.min(Math.max(activeIndex, 0), widths.length - 1);
  const normalizedWidths = widths.map((width) =>
    Number.isFinite(width) ? Math.max(0, width) : Number.POSITIVE_INFINITY,
  );
  const totalWidth = normalizedWidths.reduce((sum, width) => sum + width, 0);
  if (totalWidth <= availableWidth) {
    return { visible: widths.map((_, index) => index), stacked: [] };
  }

  const visible = new Set([active]);
  const triggerSpace = Math.max(0, stackTriggerWidth);
  const budget = Math.max(0, availableWidth - triggerSpace);
  let used = normalizedWidths[active];
  const candidates = widths
    .map((_, index) => index)
    .filter((index) => index !== active)
    .sort(
      (left, right) =>
        Math.abs(left - active) - Math.abs(right - active) || left - right,
    );

  for (const index of candidates) {
    const width = normalizedWidths[index];
    if (used + width > budget) continue;
    visible.add(index);
    used += width;
  }

  return {
    visible: [...visible].sort((left, right) => left - right),
    stacked: widths
      .map((_, index) => index)
      .filter((index) => !visible.has(index)),
  };
}

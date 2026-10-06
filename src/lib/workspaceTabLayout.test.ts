import { describe, expect, it } from "vitest";
import { partitionVisibleTabs } from "./workspaceTabLayout";

describe("partitionVisibleTabs", () => {
  it.each([
    {
      name: "keeps every tab when all fit",
      widths: [80, 100, 90],
      available: 300,
      active: 1,
      visible: [0, 1, 2],
      stacked: [],
    },
    {
      name: "keeps an active tab at the end visible",
      widths: [90, 90, 90, 90],
      available: 230,
      active: 3,
      visible: [2, 3],
      stacked: [0, 1],
    },
    {
      name: "shows only the active tab in a very narrow pane",
      widths: [130, 210, 90],
      available: 50,
      active: 1,
      visible: [1],
      stacked: [0, 2],
    },
    {
      name: "reserves space for the stack trigger with long titles",
      widths: [220, 220, 220],
      available: 270,
      active: 1,
      visible: [1],
      stacked: [0, 2],
    },
  ])("$name", ({ widths, available, active, visible, stacked }) => {
    expect(partitionVisibleTabs(widths, available, active, 36)).toEqual({
      visible,
      stacked,
    });
  });
});

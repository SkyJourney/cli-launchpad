import { describe, expect, it } from "vitest";
import { moveProjectWithinPinGroup } from "./projectOrdering";

const projects = [
  { id: 1, pinned: true },
  { id: 2, pinned: true },
  { id: 3, pinned: false },
  { id: 4, pinned: false },
];

describe("project ordering", () => {
  it("moves a project before or after another in the same pin group", () => {
    expect(moveProjectWithinPinGroup(projects, 2, 1, "before")).toEqual([2, 1]);
    expect(moveProjectWithinPinGroup(projects, 3, 4, "after")).toEqual([4, 3]);
  });

  it("does not move projects across pin groups", () => {
    expect(moveProjectWithinPinGroup(projects, 1, 3, "after")).toBeNull();
  });

  it("ignores a drop onto the dragged project", () => {
    expect(moveProjectWithinPinGroup(projects, 3, 3, "before")).toBeNull();
  });
});

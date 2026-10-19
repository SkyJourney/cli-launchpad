import { describe, expect, it } from "vitest";
import type { Directory } from "./tauri";
import { orderProjectDirectories } from "./projectOrder";

function project(
  id: number,
  name: string,
  sortOrder: number,
  pinned = false,
): Directory {
  return {
    id,
    name,
    path: `C:\\Projects\\${name}`,
    sortOrder,
    pinned,
    note: null,
  };
}

describe("orderProjectDirectories", () => {
  it("puts pinned projects first", () => {
    const directories = [
      project(1, "alpha", 0),
      project(2, "bravo", 3, true),
      project(3, "charlie", 1),
      project(4, "delta", 2, true),
    ];

    const ordered = orderProjectDirectories(directories, "");

    expect(ordered.map((entry) => entry.name)).toEqual([
      "delta",
      "bravo",
      "alpha",
      "charlie",
    ]);
    // Reverse: pinned projects stay in sort order among themselves.
    expect(ordered.slice(0, 2).map((entry) => entry.sortOrder)).toEqual([2, 3]);
  });

  it("orders by sortOrder and then by name", () => {
    const beta = project(1, "beta", 4);
    const alpha = project(2, "Alpha", 4);
    const first = project(3, "zulu", 1);
    const input = [beta, alpha, first];

    const ordered = orderProjectDirectories(input, "");

    expect(ordered.map((entry) => entry.name)).toEqual([
      "zulu",
      "Alpha",
      "beta",
    ]);
    // Reverse: the input array is not reordered in place.
    expect(Object.is(input[0], beta)).toBe(true);
    expect(input.map((entry) => entry.name)).toEqual(["beta", "Alpha", "zulu"]);
  });

  it("filters by a case-insensitive name search and keeps the order", () => {
    const directories = [
      project(1, "Alpha", 0),
      project(2, "bravo", 1),
      project(3, "Global", 2),
      project(4, "Zed", 3),
    ];

    expect(
      orderProjectDirectories(directories, "  AL ").map((entry) => entry.name),
    ).toEqual(["Alpha", "Global"]);
    // Reverse: an empty or blank search returns every project.
    expect(orderProjectDirectories(directories, "").length).toBe(4);
    expect(orderProjectDirectories(directories, "   ").length).toBe(4);
  });
});

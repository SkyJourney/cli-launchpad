import { describe, expect, it } from "vitest";
import { saveAllDirtyFiles } from "./saveAllDirtyFiles";

/** 一个可变的假宿主：保存成功会清空脏标记；`failing` 中的文件保存后仍然脏。 */
function fakeHost(dirty: string[], failing: string[] = []) {
  const state = new Set(dirty);
  const saved: string[] = [];
  return {
    state,
    saved,
    isDirty: (id: string) => state.has(id),
    save: async (id: string) => {
      saved.push(id);
      if (!failing.includes(id)) state.delete(id);
    },
  };
}

describe("saveAllDirtyFiles", () => {
  it("SAD-1 saves every dirty file in order and returns nothing when all succeed", async () => {
    const host = fakeHost(["a", "b", "c"]);
    const remaining = await saveAllDirtyFiles(
      ["a", "b", "c"],
      host.save,
      host.isDirty,
    );
    expect(remaining).toEqual([]);
    expect(host.saved).toEqual(["a", "b", "c"]);
  });

  it("SAD-2 keeps saving the others after one failure and returns only the still-dirty files", async () => {
    const host = fakeHost(["a", "b", "c"], ["b"]);
    const remaining = await saveAllDirtyFiles(
      ["a", "b", "c"],
      host.save,
      host.isDirty,
    );
    expect(host.saved).toEqual(["a", "b", "c"]);
    expect(remaining).toEqual(["b"]);
  });

  it("SAD-3 does not save files that are already clean, and a thrown save leaves the file dirty", async () => {
    const host = fakeHost(["b"]);
    const throwing = async (id: string) => {
      host.saved.push(id);
      throw new Error("disk full");
    };
    const remaining = await saveAllDirtyFiles(
      ["a", "b"],
      throwing,
      host.isDirty,
    );
    expect(host.saved).toEqual(["b"]);
    expect(remaining).toEqual(["b"]);
  });

  it("SAD-4 reads the live state after each save (a stale snapshot would report everything dirty)", async () => {
    const host = fakeHost(["a", "b"]);
    // The first save clears "a"; the check for "a" after the loop must see the cleared state.
    const remaining = await saveAllDirtyFiles(["a"], host.save, host.isDirty);
    expect(remaining).toEqual([]);
    expect(host.state.has("b")).toBe(true);
  });
});

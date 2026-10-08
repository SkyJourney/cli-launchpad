// 宿主源码棘轮（只减不增）。
// 基线来源：2026-10-06 的统计值 7（`detachedFilesRef` / `detachedByInstanceRef` 的 `.has(` 判据），
// 由 m6-019 清零。规则：目标值为 0，不得上调；窗口句柄表只允许用于取窗口对象和增删条目，
// 归属判断只读 coordinator。
// m6-052 会向本文件追加内容类型分支数（FE-T56 第一用例）。
import { describe, expect, it } from "vitest";
import hostSource from "./PtyWorkspace.tsx?raw";

const HANDLE_TABLE_PREDICATE =
  /detached(?:Files|ByInstance)Ref\.current\.has\(/g;

describe("PtyWorkspace ratchet", () => {
  it("never uses window handle tables as ownership predicates", () => {
    // 反向断言：正则本身必须能匹配两种写法，防止它被改坏后永远通过。
    const sample =
      "detachedFilesRef.current.has(x) detachedByInstanceRef.current.has(y)";
    expect(sample.match(HANDLE_TABLE_PREDICATE) ?? []).toHaveLength(2);

    expect(hostSource.match(HANDLE_TABLE_PREDICATE) ?? []).toHaveLength(0);
  });
});

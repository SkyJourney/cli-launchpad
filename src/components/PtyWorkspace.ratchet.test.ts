// 宿主源码棘轮（只减不增）。
// 基线来源：2026-10-06 的统计值 7（`detachedFilesRef` / `detachedByInstanceRef` 的 `.has(` 判据），
// 由 m6-019 清零。规则：目标值为 0，不得上调；窗口句柄表只允许用于取窗口对象和增删条目，
// 归属判断只读 coordinator。
// m6-052 会向本文件追加内容类型分支数（FE-T56 第一用例）。
import { describe, expect, it } from "vitest";
import contentKinds from "../../contracts/content-kinds.json";
import hostSource from "./PtyWorkspace.tsx?raw";

const workspaceSources = import.meta.glob(
  [
    "../workspace/**/*.ts",
    "../workspace/**/*.tsx",
    "!../workspace/**/*.test.ts",
    "!../workspace/**/*.test.tsx",
  ],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

// B-G3 target: the host file holds at most as many kind branches as the domain
// table has entries (contracts/content-kinds.json). m6-052 recorded 48 for
// host plus views; m6-098 narrowed this constant to the host file alone.
const KIND_BRANCH_BASELINE = 2;
// Total across the host and everything under src/workspace at the start of
// m6-098 (never increase; lower when branches go away). It is 48 (host plus
// views at the end of m6-052) plus 6 branches that already existed outside
// that scope: fileDocumentsDomain 1, workspaceCommandExecutor 3,
// useDetachedContentWindow 1, windowLaunchParams 1. Moving code out of the host
// must never hide branches, so host plus everything else stays within it.
const KIND_BRANCH_TOTAL_AT_M6_052 = 54;
// Measured at the end of m6-098 (never increase; lower when branches go away).
const HOST_KIND_BRANCHES_AT_M6_098 = 0;
const KIND_BRANCH_OUTSIDE_HOST_BASELINE = 54;
const WORKSPACE_SOURCE_COUNT_FLOOR = 36;
const HOST_MAX_LINES = 400;
const KIND_BRANCH_PATTERN = /kind === "|"slot" in/g;
const countKindBranches = (source: string): number =>
  (source.match(KIND_BRANCH_PATTERN) ?? []).length;

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

  it("does not grow kind branches in the host", () => {
    expect(KIND_BRANCH_BASELINE).toBe(contentKinds.kinds.length);
    const count = countKindBranches(hostSource);
    expect(count).toBeLessThanOrEqual(KIND_BRANCH_BASELINE);
    expect(count).toBeLessThanOrEqual(HOST_KIND_BRANCHES_AT_M6_098);
  });

  it("does not grow kind branches outside the host", () => {
    const sources = Object.values(workspaceSources);
    expect(sources.length).toBeGreaterThanOrEqual(WORKSPACE_SOURCE_COUNT_FLOOR);
    // 反向：视图辅助模块也必须被扫描（否则其中的 kind 分支会漏计）。
    expect(
      Object.keys(workspaceSources).some((path) =>
        path.endsWith("/viewHelpers.ts"),
      ),
    ).toBe(true);
    const outside = sources.reduce(
      (sum, source) => sum + countKindBranches(source),
      0,
    );
    expect(outside).toBeLessThanOrEqual(KIND_BRANCH_OUTSIDE_HOST_BASELINE);
    expect(countKindBranches(hostSource) + outside).toBeLessThanOrEqual(
      KIND_BRANCH_TOTAL_AT_M6_052,
    );
  });

  it("keeps PtyWorkspace.tsx an assembly file of at most 400 lines", () => {
    const lineCount = hostSource.endsWith("\n")
      ? hostSource.split("\n").length - 1
      : hostSource.split("\n").length;
    expect(lineCount).toBeLessThanOrEqual(HOST_MAX_LINES);
  });
});

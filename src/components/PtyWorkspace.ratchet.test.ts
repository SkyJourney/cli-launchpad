// 宿主源码棘轮（只减不增）。
// 基线来源：2026-10-06 的统计值 7（`detachedFilesRef` / `detachedByInstanceRef` 的 `.has(` 判据），
// 由 m6-019 清零。规则：目标值为 0，不得上调；窗口句柄表只允许用于取窗口对象和增删条目，
// 归属判断只读 coordinator。
// 后续目标向本文件追加了：内容类型分支数（m6-052、m6-098：宿主与宿主以外分别只减不增）、
// 宿主行数上限（m6-098）、窗口编排与协议处理文件的行数上限（B17 收尾）。
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
// m6-092 与 m6-097 的文档没有为 src/workspace/windows 设行数上限，三个文件在 B17
// 结束时超过 500 行。上限取 B17 结束时的实测值（只减不增；拆分或瘦身后调低；m6-104 把类型拆到 contentWindowTypes.ts，调至 733；收尾复评 B17-04：protocolHandlers.file.ts 846→759、protocolHandlers.pty.ts 606→586，取当前实测值），
// 防止它们在后续目标中继续膨胀。
const WINDOW_FILE_MAX_LINES = {
  "../workspace/windows/contentWindowOrchestrator.ts": 733,
  "../workspace/windows/protocolHandlers.file.ts": 759,
  "../workspace/windows/protocolHandlers.pty.ts": 586,
} as const;
const windowSources = import.meta.glob(
  [
    "../workspace/windows/contentWindowOrchestrator.ts",
    "../workspace/windows/protocolHandlers.file.ts",
    "../workspace/windows/protocolHandlers.pty.ts",
  ],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;
const KIND_BRANCH_PATTERN = /kind === "|"slot" in/g;
const countKindBranches = (source: string): number =>
  (source.match(KIND_BRANCH_PATTERN) ?? []).length;

// 句柄表的两代写法：宿主里的 detached*Ref（m6-019 之前），以及搬到
// workspace/windows 之后的 state.handles.{pty,file}（m6-052 之后）。两者都不得作归属判据。
const HANDLE_TABLE_PREDICATE =
  /(?:detached(?:Files|ByInstance)Ref\.current|handles\.(?:pty|file))\.has\(/g;

describe("PtyWorkspace ratchet", () => {
  it("never uses window handle tables as ownership predicates", () => {
    // 反向断言：正则本身必须能匹配两种写法，防止它被改坏后永远通过。
    const sample =
      "detachedFilesRef.current.has(x) detachedByInstanceRef.current.has(y) " +
      "state.handles.file.has(z) handles.pty.has(w)";
    expect(sample.match(HANDLE_TABLE_PREDICATE) ?? []).toHaveLength(4);

    // 句柄表已搬离宿主文件：只扫宿主文件会让守护空转，所以同时扫 src/workspace 下全部非测试源码。
    const scanned = [hostSource, ...Object.values(workspaceSources)];
    expect(Object.keys(workspaceSources).length).toBeGreaterThanOrEqual(
      WORKSPACE_SOURCE_COUNT_FLOOR,
    );
    expect(
      Object.keys(workspaceSources).some((path) =>
        path.endsWith("/contentWindowOrchestrator.ts"),
      ),
    ).toBe(true);
    const offenders = scanned.flatMap(
      (source) => source.match(HANDLE_TABLE_PREDICATE) ?? [],
    );
    expect(offenders).toHaveLength(0);
  });

  it("does not grow kind branches in the host", () => {
    expect(KIND_BRANCH_BASELINE).toBe(contentKinds.items.length);
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

  it("does not grow the window orchestration and protocol files", () => {
    // 反向：三个文件都必须被扫描到，改名或移动后不能静默通过。
    expect(Object.keys(windowSources).sort()).toEqual(
      Object.keys(WINDOW_FILE_MAX_LINES).sort(),
    );
    for (const [path, source] of Object.entries(windowSources)) {
      const lineCount = source.endsWith("\n")
        ? source.split("\n").length - 1
        : source.split("\n").length;
      const max =
        WINDOW_FILE_MAX_LINES[path as keyof typeof WINDOW_FILE_MAX_LINES];
      expect(lineCount, path).toBeLessThanOrEqual(max);
    }
  });
});

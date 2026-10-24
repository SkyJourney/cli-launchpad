import { describe, expect, it } from "vitest";

// m6-096 单一来源扫描：窗口类命令的提交只允许出现在执行器里。
// 源码按相对 src/ 的路径归一（去掉 CRLF 差异后再匹配）。
const sources = import.meta.glob("../../**/*.{ts,tsx}", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

const srcRelative = (key: string): string =>
  new URL(key, "file:///src/workspace/host/").pathname.split("/src/")[1] ?? key;

const productionSources = Object.entries(sources)
  .map(
    ([key, text]) => [srcRelative(key), text.replace(/\r\n/g, "\n")] as const,
  )
  .filter(([path]) => !/\.test\.tsx?$/.test(path));

const sourceOf = (path: string): string => {
  const match = productionSources.find(([candidate]) => candidate === path);
  if (!match) throw new Error(`missing source ${path}`);
  return match[1];
};

const countOf = (text: string, needle: string): number =>
  text.split(needle).length - 1;

const EXECUTOR = "workspace/host/workspaceCommandExecutor.ts";
const HANDLERS_PTY = "workspace/windows/protocolHandlers.pty.ts";
const HANDLERS_FILE = "workspace/windows/protocolHandlers.file.ts";
// 尾部握手的共享实现（pendingHandshake.ts）也是尾部：命令在那里构造，计入两侧的扫描。
const HANDSHAKE = "workspace/windows/pendingHandshake.ts";
const ORCHESTRATOR = "workspace/windows/contentWindowOrchestrator.ts";
const PERSISTENCE = "workspace/persistence/workspacePersistence.ts";

/**
 * 迁移后允许保留在 `commitTree(` 与 `setFocusedPane(` 上的非尾部调用点（每个文件的出现次数）。
 * 目前只有 orchestrator 的 deps 适配器两行（`commitTree: (next) => current().commitTree(next)` 与对应的 setFocusedPane）。
 * 096b 收尾时若适配器已被删除，本清单改为空数组。
 */
const ALLOWED_KEEPERS: Array<{ file: string; count: number }> = [
  { file: ORCHESTRATOR, count: 2 },
];

describe("window commands single source", () => {
  it("the executor defines the four window commands", () => {
    const executor = sourceOf(EXECUTOR);
    for (const type of [
      "completeDetach",
      "completeReturn",
      "reclaim",
      "applyPreset",
    ]) {
      expect(countOf(executor, `type: "${type}"`), type).toBeGreaterThanOrEqual(
        1,
      );
      expect(countOf(executor, `case "${type}"`), type).toBe(1);
    }
    // 窗口类命令都不在提交后调用 afterCommit（第三个参数为 null）。
    const noAfterEffect =
      /finish\("(completeDetach|completeReturn|reclaim|applyPreset)",\s*[^,]+,\s*null/g;
    expect(executor.match(noAfterEffect)?.length).toBe(4);
  });

  it("window handlers and persistence only construct commands for the tails", () => {
    const handshake = sourceOf(HANDSHAKE);
    const pty = sourceOf(HANDLERS_PTY) + handshake;
    const file = sourceOf(HANDLERS_FILE) + handshake;
    const orchestrator = sourceOf(ORCHESTRATOR);
    const persistence = sourceOf(PERSISTENCE);
    for (const type of ["completeDetach", "completeReturn", "reclaim"]) {
      expect(
        countOf(pty, `type: "${type}"`),
        `pty ${type}`,
      ).toBeGreaterThanOrEqual(1);
      expect(
        countOf(file, `type: "${type}"`),
        `file ${type}`,
      ).toBeGreaterThanOrEqual(1);
    }
    expect(
      countOf(orchestrator, `type: "completeDetach"`),
    ).toBeGreaterThanOrEqual(1);
    expect(countOf(persistence, `type: "applyPreset"`)).toBe(1);

    // 这些编排原语只允许出现在执行器里；orchestrator 的 ensureAttached 是分离开始前的预处理，不是尾部，
    // 因此不在禁止列表中（见 096 偏差表）。
    const forbiddenEverywhere = [
      "reduceWorkspaceTree(",
      "planWorkspaceReturn(",
      ".ownerEnded(",
      ".completeHandoff(",
    ];
    for (const [path, text] of [
      [HANDLERS_PTY, pty],
      [HANDLERS_FILE, file],
      [ORCHESTRATOR, orchestrator],
      [PERSISTENCE, persistence],
    ] as const) {
      for (const needle of forbiddenEverywhere) {
        expect(countOf(text, needle), `${path} ${needle}`).toBe(0);
      }
    }
    for (const [path, text] of [
      [HANDLERS_PTY, pty],
      [HANDLERS_FILE, file],
      [PERSISTENCE, persistence],
    ] as const) {
      expect(countOf(text, ".ensureAttached("), `${path} ensureAttached`).toBe(
        0,
      );
    }
  });

  it("the four tails no longer commit the tree or focus themselves", () => {
    const files = [HANDLERS_PTY, HANDLERS_FILE, ORCHESTRATOR, PERSISTENCE];
    for (const path of files) {
      const text = sourceOf(path);
      const actual =
        countOf(text, "commitTree(") + countOf(text, "setFocusedPane(");
      const allowed =
        ALLOWED_KEEPERS.find((item) => item.file === path)?.count ?? 0;
      expect(actual, path).toBe(allowed);
    }
    expect(countOf(sourceOf(PERSISTENCE), ".ensureAttached(")).toBe(0);
    for (const path of [HANDLERS_PTY, HANDLERS_FILE, ORCHESTRATOR]) {
      expect(countOf(sourceOf(path), ".completeHandoff("), path).toBe(0);
    }
  });
});

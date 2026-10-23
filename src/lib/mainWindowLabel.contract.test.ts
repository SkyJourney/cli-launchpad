import { describe, expect, it } from "vitest";
import windowKinds from "../../contracts/window-kinds.json";
import { isExcludedFromClosure, projectSources } from "../test/sourceClosure";
import { MAIN_WINDOW_LABEL, type MainWindowLabel } from "./windowKinds";

const REASONS = [
  "窗口类别 id，不是窗口 label",
  "标题栏界面变体名，不是窗口 label",
  "主窗口 label 类型 MainWindowLabel 的唯一定义",
] as const;

/** 逐文件允许表：键是 "src/..." 路径；count 是该文件允许的 "main" 字面量次数（只减不增），reasons 列出这些次数各自的理由。 */
const ALLOWED: Record<
  string,
  { count: number; reasons: readonly (typeof REASONS)[number][] }
> = {
  "src/App.tsx": {
    count: 2,
    reasons: [
      "窗口类别 id，不是窗口 label",
      "标题栏界面变体名，不是窗口 label",
    ],
  },
  "src/components/WindowTitlebar.tsx": {
    count: 1,
    reasons: ["标题栏界面变体名，不是窗口 label"],
  },
  "src/lib/tauri.ts": { count: 1, reasons: ["窗口类别 id，不是窗口 label"] },
  "src/lib/windowInbox.ts": {
    count: 1,
    reasons: ["窗口类别 id，不是窗口 label"],
  },
  "src/lib/windowKinds.ts": {
    count: 4,
    reasons: [
      "窗口类别 id，不是窗口 label",
      "窗口类别 id，不是窗口 label",
      "窗口类别 id，不是窗口 label",
      "主窗口 label 类型 MainWindowLabel 的唯一定义",
    ],
  },
};

const MAIN_LITERAL = /["']main["']/g;

function violations(
  sources: Record<string, string>,
  allowed: Record<string, { count: number }>,
): string[] {
  return Object.entries(sources)
    .filter(
      ([path]) =>
        !isExcludedFromClosure(path) && !path.startsWith("src/generated/"),
    )
    .flatMap(([path, source]) => {
      const count = source.match(MAIN_LITERAL)?.length ?? 0;
      const limit = allowed[path]?.count ?? 0;
      return count > limit ? [`${path}: ${count} 处，允许 ${limit} 处`] : [];
    });
}

describe("main window label literals", () => {
  it("limits main literals to the allowlist per file", () => {
    expect(violations({ "src/x.ts": 'const a = "main";' }, {})).toHaveLength(1);
    expect(Object.keys(projectSources).length).toBeGreaterThan(50);
    for (const entry of Object.values(ALLOWED)) {
      expect(entry.reasons).toHaveLength(entry.count);
      for (const reason of entry.reasons) expect(REASONS).toContain(reason);
    }
    const found = violations(projectSources, ALLOWED);
    expect(found, found.join("\n")).toEqual([]);
  });

  it("exposes a typed main window label equal to the contract", () => {
    const primary = (
      windowKinds.items as { primary?: boolean; label?: string }[]
    ).filter((item) => item.primary);
    expect(primary).toHaveLength(1);
    const typed: MainWindowLabel = MAIN_WINDOW_LABEL;
    expect(typed).toBe(primary[0].label);
    expect(typed).toBe("main");
  });
});

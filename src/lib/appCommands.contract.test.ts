import { describe, expect, it } from "vitest";
import appCommands from "../../contracts/app-commands.json";
import windowKinds from "../../contracts/window-kinds.json";
import {
  importSpecifiers,
  isExcludedFromClosure,
  projectSources,
  resolveRelativeImport,
} from "../test/sourceClosure";
import { closureOfWindowKind, type WindowKindId } from "../test/windowClosures";

const TAURI_MODULE = "src/lib/tauri.ts";

// 主窗口专用调用：这些封装只在主窗口执行路径中被调用，子窗口闭包因为静态导入而包含它们。
// PtyTerminal.tsx 的 createPtySession/reattachPtySession 只在主窗口创建或恢复会话时调用，
// 独立终端窗口走 attachHandoff（complete_pty_handoff）路径；
// useThemeSync.ts 的 setTrayMenuLabels 只在 currentWindowLabel === "main" 分支调用。
// 运行时证明属于 FE-T32；该规格在 tmp/goals/README.md 总表中尚未分配目标。
const MAIN_ONLY_CALLS: Record<string, string[]> = {
  "src/components/PtyTerminal.tsx": ["createPtySession", "reattachPtySession"],
  "src/hooks/useThemeSync.ts": ["setTrayMenuLabels"],
};

/** 读取源码时统一换行：Windows 检出的 tauri.ts 是 CRLF，切分正则不应依赖换行形态。 */
function normalizedSource(path: string): string {
  return projectSources[path].replace(/\r\n/g, "\n");
}

/** tauri.ts 的“导出函数名 → 命令名”。任一封装解析不出时抛错，不静默跳过。 */
function wrapperCommands(): Map<string, string> {
  const source = normalizedSource(TAURI_MODULE);
  const parts = source
    .split(/^(?=export (?:async )?function )/m)
    .filter((part) => /^export (?:async )?function /.test(part));
  const wrappers = new Map<string, string>();
  for (const part of parts) {
    const name = /^export (?:async )?function (\w+)/.exec(part)?.[1];
    const command =
      /\binvoke\s*(?:<[\s\S]*?>)?\s*\(\s*["']([a-z_0-9]+)["']/.exec(part)?.[1];
    if (!name || !command) {
      throw new Error(`unparsed wrapper: ${part.slice(0, 80)}`);
    }
    wrappers.set(name, command);
  }
  return wrappers;
}

const IMPORT_STATEMENT =
  /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;

/** 某模块从 tauri.ts 导入并实际引用的封装（原名）。 */
function usedWrappers(path: string, wrappers: Map<string, string>): string[] {
  // 先去掉注释：注释里提到封装名不算使用，否则陈旧的豁免会被注释“保活”。
  const source = normalizedSource(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1");
  const used = new Set<string>();
  for (const match of source.matchAll(IMPORT_STATEMENT)) {
    if (
      resolveRelativeImport(path, match[2], projectSources) !== TAURI_MODULE
    ) {
      continue;
    }
    const withoutStatement = source.replace(match[0], "");
    for (const item of match[1].split(",")) {
      const text = item.trim();
      if (!text || text.startsWith("type ")) continue;
      const [original, local = original] = text.split(/\s+as\s+/);
      if (!wrappers.has(original)) continue;
      if (new RegExp("\\b" + local + "\\b").test(withoutStatement)) {
        used.add(original);
      }
    }
  }
  return [...used];
}

function commandsUsedBy(kindId: WindowKindId): {
  commands: Set<string>;
  modules: string[];
} {
  const wrappers = wrapperCommands();
  const commands = new Set<string>();
  const modules: string[] = [];
  for (const path of closureOfWindowKind(kindId)) {
    if (path === TAURI_MODULE) continue;
    const names = usedWrappers(path, wrappers).filter(
      (name) => !(MAIN_ONLY_CALLS[path] ?? []).includes(name),
    );
    if (names.length === 0) continue;
    modules.push(path);
    for (const name of names) commands.add(wrappers.get(name) as string);
  }
  return { commands, modules };
}

describe("app command usage", () => {
  it("wraps exactly the registered app commands in tauri.ts", () => {
    const wrappers = wrapperCommands();

    expect([...wrappers.values()].sort()).toEqual([...appCommands].sort());
    expect(new Set(wrappers.values()).size).toBe(wrappers.size);
    expect(wrappers.size).toBe(appCommands.length);
    expect(wrappers.has("createPtySession")).toBe(true);
    expect(wrappers.get("createPtySession")).toBe("create_pty_session");
  });

  it("does not import invoke outside tauri.ts", () => {
    const violations: string[] = [];
    for (const [path, source] of Object.entries(projectSources)) {
      if (path === TAURI_MODULE || isExcludedFromClosure(path)) continue;
      if (
        /import\s*(?:type\s*)?\{[^}]*\binvoke\b[^}]*\}\s*from\s*["']@tauri-apps\/api\/core["']/.test(
          source,
        ) ||
        /import\s*\*\s*as\s+\w+\s+from\s*["'][^"']*\/tauri["']/.test(source) ||
        // 动态导入与值 re-export 同样会绕开 usedWrappers 的静态导入解析。
        /import\s*\(\s*["'][^"']*\/tauri["']\s*\)/.test(source) ||
        /export\s+(?:\*|\{[^}]*\})\s*(?:as\s+\w+\s*)?from\s*["'][^"']*\/tauri["']/.test(
          source,
        )
      ) {
        violations.push(path);
      }
    }

    expect(violations).toEqual([]);
    expect(importSpecifiers(projectSources[TAURI_MODULE])).toContain(
      "@tauri-apps/api/core",
    );
  });

  it.each(["terminal", "workspaceContent"] as const)(
    "only references wrappers allowed for %s windows",
    (kindId) => {
      const { commands } = commandsUsedBy(kindId);
      const allowed = windowKinds.kinds.find((kind) => kind.id === kindId)
        ?.appCommands as string[];

      expect(
        [...commands].filter((command) => !allowed.includes(command)),
      ).toEqual([]);
      for (const forbidden of [
        "create_pty_session",
        "reattach_pty_session",
        "open_project_file",
        "save_project_text_file",
      ]) {
        expect(commands.has(forbidden)).toBe(false);
      }
      expect(commands.size).toBeGreaterThan(0);
    },
  );

  it("keeps the main-only call exemptions live", () => {
    const wrappers = wrapperCommands();
    const closures = {
      terminal: closureOfWindowKind("terminal"),
      workspaceContent: closureOfWindowKind("workspaceContent"),
    };

    expect(Object.keys(MAIN_ONLY_CALLS)).toHaveLength(2);
    expect(Object.values(MAIN_ONLY_CALLS).flat()).toHaveLength(3);
    for (const [path, names] of Object.entries(MAIN_ONLY_CALLS)) {
      const kindsContaining = (
        Object.keys(closures) as Array<keyof typeof closures>
      ).filter((kindId) => closures[kindId].includes(path));
      expect(kindsContaining.length).toBeGreaterThan(0);
      const used = usedWrappers(path, wrappers);
      for (const name of names) {
        expect(wrappers.has(name)).toBe(true);
        expect(used).toContain(name);
        for (const kindId of kindsContaining) {
          const allowed = windowKinds.kinds.find((kind) => kind.id === kindId)
            ?.appCommands as string[];
          expect(allowed).not.toContain(wrappers.get(name));
        }
      }
    }
  });
});

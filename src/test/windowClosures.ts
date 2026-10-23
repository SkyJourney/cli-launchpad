import { computeImportClosure, projectSources } from "./sourceClosure";

export type WindowKindId = "main" | "terminal" | "workspaceContent";

export const WINDOW_ENTRIES: Record<WindowKindId, string[]> = {
  main: ["src/main.tsx"],
  terminal: [
    "src/components/StandalonePtyWindow.tsx",
    "src/hooks/useThemeSync.ts",
  ],
  workspaceContent: [
    "src/components/StandaloneWorkspaceFileWindow.tsx",
    "src/hooks/useThemeSync.ts",
  ],
};

// 只在 label === "main" 时执行：useThemeSync.ts 的 `currentWindowLabel === "main"`
// 分支才会调用 appPreferencesMain。子窗口闭包在此处停止遍历。
// 运行时证明属于 FE-T32；该规格在 tmp/goals/README.md 总表中尚未分配目标，
// 在它落地之前，这条豁免只有静态依据。
export const MAIN_ONLY_MODULES = ["src/lib/appPreferencesMain.ts"];

export function closureOfWindowKind(kindId: WindowKindId): string[] {
  return computeImportClosure(WINDOW_ENTRIES[kindId], projectSources, {
    stopAt: kindId === "main" ? [] : MAIN_ONLY_MODULES,
  });
}

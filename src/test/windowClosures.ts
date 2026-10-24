import windowKinds from "../../contracts/window-kinds.json";
import { computeImportClosure, projectSources } from "./sourceClosure";

export type WindowKindId = (typeof windowKinds.items)[number]["id"];

// 入口表由契约派生：主窗口为 main.tsx；其他窗口为其路由外壳模块（动态导入会被闭包扫描跟随）加共享的主题同步模块。
export const WINDOW_ENTRIES: Record<WindowKindId, string[]> = Object.fromEntries(
  windowKinds.items.map((kind) => [
    kind.id,
    kind.primary
      ? ["src/main.tsx"]
      : [
          `src/components/windowShells/${kind.route}.tsx`,
          "src/hooks/useThemeSync.ts",
        ],
  ]),
) as Record<WindowKindId, string[]>;

// 只在 label === "main" 时执行：useThemeSync.ts 的 `currentWindowLabel === "main"`
// 分支才会调用 appPreferencesMain。子窗口闭包在此处停止遍历。
// 运行时证明属于 FE-T32；该规格在 tmp/goals/README.md 总表中尚未分配目标，
// 在它落地之前，这条豁免只有静态依据。
export const MAIN_ONLY_MODULES = ["src/lib/appPreferencesMain.ts"];

export function closureOfWindowKind(kindId: WindowKindId): string[] {
  return computeImportClosure(WINDOW_ENTRIES[kindId], projectSources, {
    stopAt: windowKinds.items.find((kind) => kind.id === kindId)?.primary ? [] : MAIN_ONLY_MODULES,
  });
}

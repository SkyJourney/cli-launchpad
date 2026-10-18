import type { LocaleKey } from "../i18n/localeKeys";
import { themeRegistry } from "./themeRegistry";

export type ThemeBase = "light" | "dark";

export type MonacoBuiltinTheme = "vs" | "vs-dark" | "hc-black" | "hc-light";

export interface TerminalAnsiPalette {
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface ThemeDefinition {
  id: string;
  apiVersion: 1;
  base: ThemeBase;
  labelKey: LocaleKey;
  monacoTheme: MonacoBuiltinTheme;
  terminal: { ansi: TerminalAnsiPalette };
}

const sharedTerminalAnsi: TerminalAnsiPalette = {
  black: "#2e3436",
  red: "#cc0000",
  green: "#4e9a06",
  yellow: "#c4a000",
  blue: "#3465a4",
  magenta: "#75507b",
  cyan: "#06989a",
  white: "#d3d7cf",
  brightBlack: "#555753",
  brightRed: "#ef2929",
  brightGreen: "#8ae234",
  brightYellow: "#fce94f",
  brightBlue: "#729fcf",
  brightMagenta: "#ad7fa8",
  brightCyan: "#34e2e2",
  brightWhite: "#eeeeec",
};

export const THEMES = {
  light: {
    id: "light",
    apiVersion: 1,
    base: "light",
    labelKey: "theme.light",
    monacoTheme: "vs",
    terminal: { ansi: sharedTerminalAnsi },
  },
  dark: {
    id: "dark",
    apiVersion: 1,
    base: "dark",
    labelKey: "theme.dark",
    monacoTheme: "vs-dark",
    terminal: { ansi: sharedTerminalAnsi },
  },
} as const satisfies Record<string, ThemeDefinition>;

export type ThemeId = keyof typeof THEMES;
export type ThemeMode = ThemeId | "system";
export type ResolvedTheme = { id: ThemeId; base: ThemeBase };

export const THEME_IDS = Object.keys(THEMES) as ThemeId[];

/** PD-07：终端始终使用深色调色板，登记为例外；终端运行时不订阅主题变化。 */
export const TERMINAL_RUNTIME_THEME_ID: ThemeId = "dark";

export function registerBuiltinThemes(): () => void {
  const registered: Array<() => void> = [];
  for (const theme of Object.values(THEMES)) {
    if (themeRegistry.get(theme.id) === theme) continue;
    registered.push(themeRegistry.register(theme));
  }
  // 内建主题是永久贡献：模块加载时已同步注册，这里只补注册缺失项；
  // 返回的清理函数只注销本次补注册的项，从不注销加载时注册的两个内建主题。
  return () => registered.reverse().forEach((dispose) => dispose());
}

// appStore 在模块导入期就调用 resolveThemeMode，早于启动期，所以必须同步注册。
registerBuiltinThemes();

export function getThemeDefinition(id: string): ThemeDefinition {
  const definition =
    themeRegistry.get(id) ?? (isThemeId(id) ? THEMES[id] : undefined);
  if (!definition) throw new Error(`未注册主题: ${id}`);
  return definition;
}

export function isThemeId(value: unknown): value is ThemeId {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(THEMES, value)
  );
}

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === "system" || isThemeId(value);
}

export function resolveThemeMode(
  mode: ThemeMode,
  systemPrefersDark: boolean,
): ResolvedTheme {
  const id = mode === "system" ? (systemPrefersDark ? "dark" : "light") : mode;
  return { id, base: getThemeDefinition(id).base };
}

export const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";

/** 当前窗口的系统暗色偏好；没有 `matchMedia`（测试环境）时按非暗色处理。 */
export function prefersDarkScheme(): boolean {
  return (
    typeof window !== "undefined" &&
    (window.matchMedia?.(DARK_SCHEME_QUERY).matches ?? false)
  );
}

/** 已解析主题的唯一产出函数：`appStore` 的初始状态与 `useThemeSync` 都经过它。 */
export function resolveCurrentTheme(mode: ThemeMode): ResolvedTheme {
  return resolveThemeMode(mode, prefersDarkScheme());
}

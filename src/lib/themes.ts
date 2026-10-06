export type ThemeBase = "light" | "dark";

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
  base: ThemeBase;
  labelKey: "theme.light" | "theme.dark";
  monacoTheme: "vs" | "vs-dark";
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
    base: "light",
    labelKey: "theme.light",
    monacoTheme: "vs",
    terminal: { ansi: sharedTerminalAnsi },
  },
  dark: {
    id: "dark",
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

export function getThemeDefinition(id: ThemeId): ThemeDefinition {
  return THEMES[id];
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
  return { id, base: THEMES[id].base };
}

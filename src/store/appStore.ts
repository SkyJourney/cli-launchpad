import { create } from "zustand";

export type ViewName =
  | "projects"
  | "detail"
  | "edit"
  | "executions"
  | "settings"
  | "about";

export type ThemeMode = "light" | "dark" | "system";

const THEME_STORAGE_KEY = "cli-launchpad.theme";

function getStoredThemeMode(): ThemeMode {
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return stored === "light" || stored === "dark" || stored === "system"
    ? stored
    : "system";
}

interface AppState {
  view: ViewName;
  themeMode: ThemeMode;
  selectedDirectoryId: number | null;
  setView: (view: ViewName) => void;
  setThemeMode: (mode: ThemeMode) => void;
  selectDirectory: (id: number | null) => void;
  openDirectory: (id: number) => void;
}

export const useAppStore = create<AppState>((set) => ({
  view: "projects",
  themeMode: getStoredThemeMode(),
  selectedDirectoryId: null,
  setView: (view) => set({ view }),
  setThemeMode: (mode) => {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
    set({ themeMode: mode });
  },
  selectDirectory: (id) => set({ selectedDirectoryId: id }),
  openDirectory: (id) => set({ selectedDirectoryId: id, view: "detail" }),
}));

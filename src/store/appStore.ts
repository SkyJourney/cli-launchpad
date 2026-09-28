import { create } from "zustand";
import type { PtySession } from "../lib/tauri";

export type ViewName =
  | "projects"
  | "detail"
  | "executions"
  | "settings"
  | "about";

export type ThemeMode = "light" | "dark" | "system";

export type ProjectDialogState =
  | { mode: "add" }
  | { mode: "edit"; directoryId: number }
  | null;

const THEME_STORAGE_KEY = "cli-launchpad.theme";
const LAST_DIRECTORY_STORAGE_KEY = "cli-launchpad.last-directory";
const CONTEXT_PANEL_STORAGE_KEY = "cli-launchpad.context-panel-open";

function getStoredThemeMode(): ThemeMode {
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return stored === "light" || stored === "dark" || stored === "system"
    ? stored
    : "system";
}

function getStoredDirectoryId(): number | null {
  const stored = window.localStorage.getItem(LAST_DIRECTORY_STORAGE_KEY);
  if (!stored) return null;
  const id = Number(stored);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function getStoredContextPanelOpen(): boolean {
  return window.localStorage.getItem(CONTEXT_PANEL_STORAGE_KEY) !== "false";
}

const initialDirectoryId = getStoredDirectoryId();

interface AppState {
  view: ViewName;
  themeMode: ThemeMode;
  selectedDirectoryId: number | null;
  contextPanelOpen: boolean;
  projectDialog: ProjectDialogState;
  ptySessionsByDirectory: Record<number, PtySession>;
  setView: (view: ViewName) => void;
  setThemeMode: (mode: ThemeMode) => void;
  selectDirectory: (id: number | null) => void;
  openDirectory: (id: number) => void;
  setContextPanelOpen: (open: boolean) => void;
  setProjectDialog: (dialog: ProjectDialogState) => void;
  setPtySession: (directoryId: number, session: PtySession | null) => void;
}

export const useAppStore = create<AppState>((set) => ({
  view: initialDirectoryId == null ? "projects" : "detail",
  themeMode: getStoredThemeMode(),
  selectedDirectoryId: initialDirectoryId,
  contextPanelOpen: getStoredContextPanelOpen(),
  projectDialog: null,
  ptySessionsByDirectory: {},
  setView: (view) => set({ view }),
  setThemeMode: (mode) => {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
    set({ themeMode: mode });
  },
  selectDirectory: (id) => {
    if (id == null) window.localStorage.removeItem(LAST_DIRECTORY_STORAGE_KEY);
    else window.localStorage.setItem(LAST_DIRECTORY_STORAGE_KEY, String(id));
    set({ selectedDirectoryId: id });
  },
  openDirectory: (id) => {
    window.localStorage.setItem(LAST_DIRECTORY_STORAGE_KEY, String(id));
    set({ selectedDirectoryId: id, view: "detail" });
  },
  setContextPanelOpen: (open) => {
    window.localStorage.setItem(CONTEXT_PANEL_STORAGE_KEY, String(open));
    set({ contextPanelOpen: open });
  },
  setProjectDialog: (dialog) => set({ projectDialog: dialog }),
  setPtySession: (directoryId, session) =>
    set((state) => {
      const next = { ...state.ptySessionsByDirectory };
      if (session) next[directoryId] = session;
      else delete next[directoryId];
      return { ptySessionsByDirectory: next };
    }),
}));

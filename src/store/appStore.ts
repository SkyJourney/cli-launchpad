import { create } from "zustand";
import type { ThemeMode } from "../lib/themeMode";
import type { PtySession } from "../lib/tauri";

export type { ThemeMode } from "../lib/themeMode";

export type ViewName =
  | "projects"
  | "detail"
  | "executions"
  | "settings"
  | "about";

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
  ptySessionsById: Record<string, PtySession>;
  setView: (view: ViewName) => void;
  setThemeMode: (mode: ThemeMode) => void;
  selectDirectory: (id: number | null) => void;
  openDirectory: (id: number) => void;
  setContextPanelOpen: (open: boolean) => void;
  setProjectDialog: (dialog: ProjectDialogState) => void;
  upsertPtySession: (session: PtySession) => void;
  removePtySession: (sessionId: string) => void;
}

export const useAppStore = create<AppState>((set) => ({
  view: initialDirectoryId == null ? "projects" : "detail",
  themeMode: getStoredThemeMode(),
  selectedDirectoryId: initialDirectoryId,
  contextPanelOpen: getStoredContextPanelOpen(),
  projectDialog: null,
  ptySessionsById: {},
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
  upsertPtySession: (session) =>
    set((state) => {
      return {
        ptySessionsById: {
          ...state.ptySessionsById,
          [session.sessionId]: session,
        },
      };
    }),
  removePtySession: (sessionId) =>
    set((state) => {
      if (!state.ptySessionsById[sessionId]) return state;
      const next = { ...state.ptySessionsById };
      delete next[sessionId];
      return { ptySessionsById: next };
    }),
}));

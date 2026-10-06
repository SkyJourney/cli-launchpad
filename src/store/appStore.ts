import { create } from "zustand";
import {
  isThemeMode,
  resolveThemeMode,
  type ResolvedTheme,
  type ThemeMode,
} from "../lib/themes";
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
const SIDEBAR_OPEN_STORAGE_KEY = "cli-launchpad.sidebar-open";
const CONTEXT_PANEL_STORAGE_KEY = "cli-launchpad.context-panel-open";

function getBrowserStorage(): Storage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

function getStoredThemeMode(): ThemeMode {
  const stored = getBrowserStorage()?.getItem(THEME_STORAGE_KEY);
  return isThemeMode(stored) ? stored : "system";
}

const initialThemeMode = getStoredThemeMode();

function getInitialResolvedTheme(): ResolvedTheme {
  const systemPrefersDark =
    typeof window !== "undefined" &&
    (window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
  return resolveThemeMode(initialThemeMode, systemPrefersDark);
}

function getStoredDirectoryId(): number | null {
  const stored = getBrowserStorage()?.getItem(LAST_DIRECTORY_STORAGE_KEY);
  if (!stored) return null;
  const id = Number(stored);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function getStoredContextPanelOpen(): boolean {
  return getBrowserStorage()?.getItem(CONTEXT_PANEL_STORAGE_KEY) !== "false";
}

function getStoredSidebarOpen(): boolean {
  return getBrowserStorage()?.getItem(SIDEBAR_OPEN_STORAGE_KEY) !== "false";
}

const initialDirectoryId = getStoredDirectoryId();

interface AppState {
  view: ViewName;
  themeMode: ThemeMode;
  resolvedTheme: ResolvedTheme;
  selectedDirectoryId: number | null;
  sidebarOpen: boolean;
  contextPanelOpen: boolean;
  projectDialog: ProjectDialogState;
  ptySessionsById: Record<string, PtySession>;
  setView: (view: ViewName) => void;
  setThemeMode: (mode: ThemeMode) => void;
  applyRemoteThemeMode: (mode: ThemeMode) => void;
  setResolvedTheme: (theme: ResolvedTheme) => void;
  selectDirectory: (id: number | null) => void;
  openDirectory: (id: number) => void;
  setSidebarOpen: (open: boolean) => void;
  setContextPanelOpen: (open: boolean) => void;
  setProjectDialog: (dialog: ProjectDialogState) => void;
  upsertPtySession: (session: PtySession) => void;
  removePtySession: (sessionId: string) => void;
  clearPtySessions: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  view: initialDirectoryId == null ? "projects" : "detail",
  themeMode: initialThemeMode,
  resolvedTheme: getInitialResolvedTheme(),
  selectedDirectoryId: initialDirectoryId,
  sidebarOpen: getStoredSidebarOpen(),
  contextPanelOpen: getStoredContextPanelOpen(),
  projectDialog: null,
  ptySessionsById: {},
  setView: (view) => set({ view }),
  setThemeMode: (mode) => {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
    set({ themeMode: mode });
  },
  applyRemoteThemeMode: (mode) => set({ themeMode: mode }),
  setResolvedTheme: (theme) =>
    set((state) =>
      state.resolvedTheme.id === theme.id &&
      state.resolvedTheme.base === theme.base
        ? state
        : { resolvedTheme: theme },
    ),
  selectDirectory: (id) => {
    if (id == null) window.localStorage.removeItem(LAST_DIRECTORY_STORAGE_KEY);
    else window.localStorage.setItem(LAST_DIRECTORY_STORAGE_KEY, String(id));
    set({ selectedDirectoryId: id });
  },
  openDirectory: (id) => {
    window.localStorage.setItem(LAST_DIRECTORY_STORAGE_KEY, String(id));
    set({ selectedDirectoryId: id, view: "detail" });
  },
  setSidebarOpen: (open) => {
    window.localStorage.setItem(SIDEBAR_OPEN_STORAGE_KEY, String(open));
    set({ sidebarOpen: open });
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
  clearPtySessions: () => set({ ptySessionsById: {} }),
}));

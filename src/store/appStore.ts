import { create } from "zustand";

export type ViewName = "projects" | "detail" | "edit" | "settings";

interface AppState {
  view: ViewName;
  selectedDirectoryId: number | null;
  setView: (view: ViewName) => void;
  selectDirectory: (id: number | null) => void;
  openDirectory: (id: number) => void;
}

export const useAppStore = create<AppState>((set) => ({
  view: "projects",
  selectedDirectoryId: null,
  setView: (view) => set({ view }),
  selectDirectory: (id) => set({ selectedDirectoryId: id }),
  openDirectory: (id) => set({ selectedDirectoryId: id, view: "detail" }),
}));

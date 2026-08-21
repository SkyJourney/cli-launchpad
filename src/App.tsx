import { useLayoutEffect, useRef } from "react";
import { Toaster } from "sonner";
import { Sidebar } from "./components/Sidebar";
import { ProjectsView } from "./views/ProjectsView";
import { ProjectDetailView } from "./views/ProjectDetailView";
import { ProjectEditView } from "./views/ProjectEditView";
import { SettingsView } from "./views/SettingsView";
import { ExecutionsView } from "./views/ExecutionsView";
import { AboutView } from "./views/AboutView";
import { useExecutionTaskEvents } from "./hooks/useExecutionTasks";
import { useThemeSync } from "./hooks/useThemeSync";
import { type ViewName, useAppStore } from "./store/appStore";

export function App() {
  const view = useAppStore((state) => state.view);
  const themeMode = useAppStore((state) => state.themeMode);
  const workspaceRef = useRef<HTMLElement>(null);
  const scrollPositions = useRef<Partial<Record<ViewName, number>>>({});
  useExecutionTaskEvents();
  useThemeSync();

  useLayoutEffect(() => {
    if (workspaceRef.current) {
      workspaceRef.current.scrollTop = scrollPositions.current[view] ?? 0;
    }
  }, [view]);

  return (
    <>
      <main className="app-shell">
        <Sidebar />
        <section
          ref={workspaceRef}
          className="workspace"
          onScroll={(event) => {
            scrollPositions.current[view] = event.currentTarget.scrollTop;
          }}
        >
          {view === "projects" && <ProjectsView />}
          {view === "detail" && <ProjectDetailView />}
          {view === "edit" && <ProjectEditView />}
          {view === "executions" && <ExecutionsView />}
          {view === "settings" && <SettingsView />}
          {view === "about" && <AboutView />}
        </section>
      </main>
      <Toaster
        position="top-right"
        theme={themeMode}
        richColors
        closeButton
        visibleToasts={4}
        duration={5000}
        toastOptions={{
          style: { fontFamily: "var(--font-ui)" },
        }}
      />
    </>
  );
}

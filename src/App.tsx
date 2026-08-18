import { useLayoutEffect, useRef } from "react";
import { Sidebar } from "./components/Sidebar";
import { ProjectsView } from "./views/ProjectsView";
import { ProjectDetailView } from "./views/ProjectDetailView";
import { ProjectEditView } from "./views/ProjectEditView";
import { SettingsView } from "./views/SettingsView";
import { ExecutionsView } from "./views/ExecutionsView";
import { AboutView } from "./views/AboutView";
import { useExecutionTaskEvents } from "./hooks/useExecutionTasks";
import { type ViewName, useAppStore } from "./store/appStore";

export function App() {
  const view = useAppStore((state) => state.view);
  const workspaceRef = useRef<HTMLElement>(null);
  const scrollPositions = useRef<Partial<Record<ViewName, number>>>({});
  useExecutionTaskEvents();

  useLayoutEffect(() => {
    if (workspaceRef.current) {
      workspaceRef.current.scrollTop = scrollPositions.current[view] ?? 0;
    }
  }, [view]);

  return (
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
  );
}

import { Sidebar } from "./components/Sidebar";
import { ProjectsView } from "./views/ProjectsView";
import { ProjectDetailView } from "./views/ProjectDetailView";
import { ProjectEditView } from "./views/ProjectEditView";
import { SettingsView } from "./views/SettingsView";
import { ExecutionsView } from "./views/ExecutionsView";
import { AboutView } from "./views/AboutView";
import { useExecutionTaskEvents } from "./hooks/useExecutionTasks";
import { useAppStore } from "./store/appStore";

export function App() {
  const view = useAppStore((state) => state.view);
  useExecutionTaskEvents();

  return (
    <main className="app-shell">
      <Sidebar />
      <section className="workspace">
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

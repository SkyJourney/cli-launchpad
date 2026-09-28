import { listen } from "@tauri-apps/api/event";
import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Toaster } from "sonner";
import { FolderOpen, Plus } from "lucide-react";
import { Sidebar } from "./components/Sidebar";
import { ProjectMaintenanceDialog } from "./components/ProjectMaintenanceDialog";
const ProjectDetailView = lazy(() =>
  import("./views/ProjectDetailView").then((module) => ({
    default: module.ProjectDetailView,
  })),
);
import { SettingsView } from "./views/SettingsView";
import { ExecutionsView } from "./views/ExecutionsView";
import { AboutView } from "./views/AboutView";
import { useExecutionTaskEvents } from "./hooks/useExecutionTasks";
import { useThemeSync } from "./hooks/useThemeSync";
import { type ViewName, useAppStore } from "./store/appStore";
import { confirmPtyExit } from "./lib/tauri";
import { useDirectories } from "./hooks/queries";

export function App() {
  const { t } = useTranslation();
  const view = useAppStore((state) => state.view);
  const themeMode = useAppStore((state) => state.themeMode);
  const selectedDirectoryId = useAppStore((state) => state.selectedDirectoryId);
  const projectDialog = useAppStore((state) => state.projectDialog);
  const setProjectDialog = useAppStore((state) => state.setProjectDialog);
  const selectDirectory = useAppStore((state) => state.selectDirectory);
  const setView = useAppStore((state) => state.setView);
  const workspaceRef = useRef<HTMLElement>(null);
  const scrollPositions = useRef<Partial<Record<ViewName, number>>>({});
  const validatedDirectoryState = useRef(false);
  const { data: directories } = useDirectories();
  const [exitRequest, setExitRequest] = useState<number | null>(null);
  const [exitPending, setExitPending] = useState(false);
  const [exitError, setExitError] = useState<string | null>(null);
  const [mountedDirectoryIds, setMountedDirectoryIds] = useState<number[]>(
    () => (selectedDirectoryId == null ? [] : [selectedDirectoryId]),
  );
  useExecutionTaskEvents();
  useThemeSync();

  useEffect(() => {
    const suppressNativeContextMenu = (event: MouseEvent) =>
      event.preventDefault();
    document.addEventListener("contextmenu", suppressNativeContextMenu, true);
    return () =>
      document.removeEventListener(
        "contextmenu",
        suppressNativeContextMenu,
        true,
      );
  }, []);

  useLayoutEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<number>("pty-exit-requested", (event) => {
      setExitRequest(event.payload);
      setExitError(null);
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const quitWithActiveSessions = async () => {
    setExitPending(true);
    setExitError(null);
    try {
      await confirmPtyExit();
    } catch (error) {
      setExitError(String(error));
      setExitPending(false);
    }
  };

  useEffect(() => {
    if (selectedDirectoryId == null) return;
    setMountedDirectoryIds((current) =>
      current.includes(selectedDirectoryId)
        ? current
        : [...current, selectedDirectoryId],
    );
  }, [selectedDirectoryId]);

  useEffect(() => {
    if (!directories) return;
    setMountedDirectoryIds((current) =>
      current.filter((id) =>
        directories.some((directory) => directory.id === id),
      ),
    );

    if (validatedDirectoryState.current) return;
    validatedDirectoryState.current = true;
    if (
      selectedDirectoryId != null &&
      !directories.some((directory) => directory.id === selectedDirectoryId)
    ) {
      selectDirectory(null);
      if (view === "detail") setView("projects");
    }
  }, [directories, selectedDirectoryId, selectDirectory, setView, view]);

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
          className={
            view === "detail" ? "workspace workspace-workbench" : "workspace"
          }
          onScroll={(event) => {
            scrollPositions.current[view] = event.currentTarget.scrollTop;
          }}
        >
          {view === "projects" && (
            <div className="empty-projects-state">
              <FolderOpen size={42} />
              <h1>{t("emptyProjects.title")}</h1>
              <p>{t("emptyProjects.description")}</p>
              <button
                className="primary-button"
                onClick={() => setProjectDialog({ mode: "add" })}
              >
                <Plus size={16} />
                {t("emptyProjects.addProject")}
              </button>
            </div>
          )}
          <Suspense fallback={null}>
            {mountedDirectoryIds.map((directoryId) => (
              <div
                key={directoryId}
                className="project-workspace-view"
                hidden={
                  view !== "detail" || selectedDirectoryId !== directoryId
                }
              >
                <ProjectDetailView
                  directoryId={directoryId}
                  active={
                    view === "detail" && selectedDirectoryId === directoryId
                  }
                />
              </div>
            ))}
          </Suspense>
          {view === "executions" && <ExecutionsView />}
          {view === "settings" && <SettingsView />}
          {view === "about" && <AboutView />}
        </section>
      </main>
      {projectDialog && (
        <ProjectMaintenanceDialog
          key={`${projectDialog.mode}-${projectDialog.mode === "edit" ? projectDialog.directoryId : "new"}`}
        />
      )}
      {exitRequest != null && (
        <div className="app-exit-overlay">
          <section className="app-exit-dialog" role="dialog" aria-modal="true">
            <h2>{t("appExit.title")}</h2>
            <p>{t("appExit.description", { count: exitRequest })}</p>
            {exitError && <p className="error">{exitError}</p>}
            <div className="app-exit-actions">
              <button
                className="ghost-button"
                disabled={exitPending}
                onClick={() => setExitRequest(null)}
              >
                {t("common.cancel")}
              </button>
              <button
                className="primary-button"
                disabled={exitPending}
                onClick={() => void quitWithActiveSessions()}
              >
                {exitPending ? t("appExit.terminating") : t("appExit.confirm")}
              </button>
            </div>
          </section>
        </div>
      )}
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

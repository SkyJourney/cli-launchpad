import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
import { FolderOpen, PanelLeft, PanelRight, Plus } from "lucide-react";
import { AppLogo } from "./components/AppLogo";
import { AppTitlebarUtilities } from "./components/AppTitlebarUtilities";
import { WorkspaceDataRestoreListener } from "./components/WorkspaceDataRestoreListener";
import { Sidebar } from "./components/Sidebar";
import { ProjectMaintenanceDialog } from "./components/ProjectMaintenanceDialog";
import { formatAppError } from "./lib/appErrors";
import {
  PtyWorkspaceProvider,
  PtyWorkspaceRegion,
  WorkspaceLayoutControls,
  usePtyWorkspace,
} from "./components/PtyWorkspace";
import {
  WindowResizeHandles,
  WindowTitlebar,
} from "./components/WindowTitlebar";
const StandalonePtyWindow = lazy(() =>
  import("./components/StandalonePtyWindow").then((module) => ({
    default: module.StandalonePtyWindow,
  })),
);
const StandaloneWorkspaceFileWindow = lazy(() =>
  import("./components/StandaloneWorkspaceFileWindow").then((module) => ({
    default: module.StandaloneWorkspaceFileWindow,
  })),
);
const ProjectDetailView = lazy(() =>
  import("./views/ProjectDetailView").then((module) => ({
    default: module.ProjectDetailView,
  })),
);
const SettingsView = lazy(() =>
  import("./views/SettingsView").then((module) => ({
    default: module.SettingsView,
  })),
);
const ExecutionsView = lazy(() =>
  import("./views/ExecutionsView").then((module) => ({
    default: module.ExecutionsView,
  })),
);
const AboutView = lazy(() =>
  import("./views/AboutView").then((module) => ({
    default: module.AboutView,
  })),
);
import { useExecutionTaskEvents } from "./hooks/useExecutionTasks";
import { indexByTool, useCliStatus } from "./hooks/useCliStatus";
import { useThemeSync } from "./hooks/useThemeSync";
import { useWindowLevelBehaviors } from "./hooks/useWindowLevelBehaviors";
import { type ViewName, useAppStore } from "./store/appStore";
import { useResolvedTheme } from "./hooks/useResolvedTheme";
import { confirmAppExit } from "./lib/tauri";
import {
  collectAppExitImpacts,
  shouldExitWithoutPrompt,
  type AppExitRequest,
} from "./lib/appExitImpacts";
import { useDirectories } from "./hooks/queries";
import { TOOLS } from "./lib/tools";
import { windowKindOf } from "./lib/windowKinds";

export function App() {
  const { t } = useTranslation();
  useThemeSync();
  const windowKind = windowKindOf(getCurrentWindow().label);
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get("detachedSessionId");
  const handoffToken = params.get("handoffToken");
  const instanceId = params.get("instanceId");
  const sourcePaneId = params.get("sourcePaneId");
  const detachedToolKey = TOOLS.find(
    (tool) => tool.key === params.get("detachedToolKey"),
  )?.key;
  const detachedFileId = params.get("detachedFileId");
  const fileHandoffToken = params.get("fileHandoffToken");
  const fileSourcePaneId = params.get("sourcePaneId");
  if (windowKind === "workspaceContent" && detachedFileId && fileHandoffToken) {
    return (
      <Suspense fallback={null}>
        <StandaloneWorkspaceFileWindow
          documentId={detachedFileId}
          token={fileHandoffToken}
          sourcePaneId={fileSourcePaneId ?? "unknown-pane"}
        />
      </Suspense>
    );
  }
  if (windowKind === "terminal" && sessionId && handoffToken && instanceId) {
    return (
      <Suspense fallback={null}>
        <StandalonePtyWindow
          sessionId={sessionId}
          handoffToken={handoffToken}
          instanceId={instanceId}
          sourcePaneId={sourcePaneId ?? "unknown-pane"}
          toolKey={detachedToolKey}
          title={params.get("detachedTitle") ?? t("pty.detachedDefaultTitle")}
        />
      </Suspense>
    );
  }
  if (windowKind !== "main") return null;
  return (
    <PtyWorkspaceProvider>
      <AppContent />
    </PtyWorkspaceProvider>
  );
}

function AppContent() {
  const { t } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;
  useWindowLevelBehaviors();
  const { collectExitImpacts, fileDocuments, fileBuffers, detachedFileIds } =
    usePtyWorkspace();
  const exitStateRef = useRef({ fileDocuments, fileBuffers, detachedFileIds });
  exitStateRef.current = { fileDocuments, fileBuffers, detachedFileIds };
  const view = useAppStore((state) => state.view);
  const resolvedTheme = useResolvedTheme();
  const selectedDirectoryId = useAppStore((state) => state.selectedDirectoryId);
  const sidebarOpen = useAppStore((state) => state.sidebarOpen);
  const setSidebarOpen = useAppStore((state) => state.setSidebarOpen);
  const contextPanelOpen = useAppStore((state) => state.contextPanelOpen);
  const setContextPanelOpen = useAppStore((state) => state.setContextPanelOpen);
  const projectDialog = useAppStore((state) => state.projectDialog);
  const setProjectDialog = useAppStore((state) => state.setProjectDialog);
  const selectDirectory = useAppStore((state) => state.selectDirectory);
  const setView = useAppStore((state) => state.setView);
  const workspaceRef = useRef<HTMLElement>(null);
  const scrollPositions = useRef<Partial<Record<ViewName, number>>>({});
  const validatedDirectoryState = useRef(false);
  const { data: directories } = useDirectories();
  const [exitRequest, setExitRequest] = useState<AppExitRequest | null>(null);
  const [exitPending, setExitPending] = useState(false);
  const [exitError, setExitError] = useState<string | null>(null);
  useExecutionTaskEvents();

  useLayoutEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<{ ptyCount: number; executionTaskCount?: number }>(
      "app-exit-requested",
      (event) => {
        setExitError(null);
        const executionTaskCount = Math.max(
          0,
          event.payload.executionTaskCount ?? 0,
        );
        void collectExitImpacts(event.payload.ptyCount)
          .then(async (collected) => {
            const impacts: AppExitRequest = {
              ...collected,
              executionTaskCount,
            };
            if (shouldExitWithoutPrompt(impacts)) {
              setExitPending(true);
              try {
                await confirmAppExit();
              } catch (error) {
                // 后端拒绝静默退出（例如检查之后又启动了 PTY）：恢复为可操作的对话框，
                // 不能停在“终止中”让两个按钮都被禁用。
                setExitPending(false);
                setExitRequest(impacts);
                setExitError(formatAppError(error, tRef.current));
              }
              return;
            }
            setExitRequest(impacts);
          })
          .catch((error) => {
            console.error("Unable to collect application exit impacts", error);
            const current = exitStateRef.current;
            setExitRequest({
              ...collectAppExitImpacts({
                ptyCount: event.payload.ptyCount,
                documents: current.fileDocuments,
                buffers: current.fileBuffers,
                uncertainDocumentIds: current.detachedFileIds,
              }),
              executionTaskCount,
            });
            setExitError(formatAppError(error, tRef.current));
          });
      },
    )
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [collectExitImpacts]);

  const quitWithActiveSessions = async () => {
    setExitPending(true);
    setExitError(null);
    try {
      await confirmAppExit();
    } catch (error) {
      setExitError(formatAppError(error, t));
      setExitPending(false);
    }
  };

  useEffect(() => {
    if (!directories) return;
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
      <WorkspaceDataRestoreListener />
      <div className="app-window-shell">
        <WindowTitlebar
          variant="main"
          leading={
            <div className="window-titlebar-brand" data-window-drag-handle>
              <AppLogo size={24} />
              <strong>CLI Launchpad</strong>
            </div>
          }
          children={
            <>
              <button
                type="button"
                className="icon-button window-titlebar-action-button"
                title={
                  sidebarOpen ? t("sidebar.collapse") : t("sidebar.expand")
                }
                aria-label={
                  sidebarOpen ? t("sidebar.collapse") : t("sidebar.expand")
                }
                aria-expanded={sidebarOpen}
                aria-controls="app-sidebar"
                onClick={() => setSidebarOpen(!sidebarOpen)}
              >
                <PanelLeft size={16} />
              </button>
              <AppTitlebarUtilities />
            </>
          }
          actions={
            view === "detail" ? (
              <>
                <CliTitlebarLaunchers directoryId={selectedDirectoryId} />
                <WorkspaceLayoutControls />
                <button
                  type="button"
                  className="icon-button window-titlebar-action-button"
                  title={
                    contextPanelOpen
                      ? t("projectDetail.hideContextPanel")
                      : t("projectDetail.showContextPanel")
                  }
                  aria-label={
                    contextPanelOpen
                      ? t("projectDetail.hideContextPanel")
                      : t("projectDetail.showContextPanel")
                  }
                  aria-expanded={contextPanelOpen}
                  onClick={() => setContextPanelOpen(!contextPanelOpen)}
                >
                  <PanelRight size={16} />
                </button>
              </>
            ) : null
          }
        />
        <main
          className={`app-shell${sidebarOpen ? "" : " app-shell-sidebar-collapsed"}`}
        >
          <Sidebar hidden={!sidebarOpen} />
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
            <div
              className={`shared-workbench${contextPanelOpen ? " context-open" : ""}`}
              hidden={view !== "detail"}
            >
              <PtyWorkspaceRegion />
              {selectedDirectoryId != null && (
                <Suspense fallback={null}>
                  <ProjectDetailView
                    key={selectedDirectoryId}
                    directoryId={selectedDirectoryId}
                    active={view === "detail"}
                  />
                </Suspense>
              )}
            </div>
            <Suspense fallback={null}>
              {view === "executions" && <ExecutionsView />}
              {view === "settings" && <SettingsView />}
              {view === "about" && <AboutView />}
            </Suspense>
          </section>
        </main>
        <WindowResizeHandles />
      </div>
      {projectDialog && (
        <ProjectMaintenanceDialog
          key={`${projectDialog.mode}-${projectDialog.mode === "edit" ? projectDialog.directoryId : "new"}`}
        />
      )}
      {exitRequest != null && (
        <div className="app-exit-overlay">
          <section className="app-exit-dialog" role="dialog" aria-modal="true">
            <h2>{t("appExit.title")}</h2>
            {exitRequest.ptyCount > 0 && (
              <p>{t("appExit.description", { count: exitRequest.ptyCount })}</p>
            )}
            {exitRequest.executionTaskCount > 0 && (
              <p>
                {t("appExit.executionTasks", {
                  count: exitRequest.executionTaskCount,
                })}
              </p>
            )}
            {exitRequest.dirtyFiles.length > 0 && (
              <>
                <p>
                  {t("appExit.unsavedDescription", {
                    count: exitRequest.dirtyFiles.length,
                  })}
                </p>
                <ul className="app-exit-unsaved-files">
                  {exitRequest.dirtyFiles.map((file) => (
                    <li key={file.documentId}>{file.relativePath}</li>
                  ))}
                </ul>
              </>
            )}
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
                {exitPending
                  ? t("appExit.terminating")
                  : t("appExit.confirmDiscard")}
              </button>
            </div>
          </section>
        </div>
      )}
      <Toaster
        position="top-center"
        offset={{ top: "calc(var(--window-titlebar-height) + 6px)" }}
        theme={resolvedTheme.base}
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

function CliTitlebarLaunchers({ directoryId }: { directoryId: number | null }) {
  const { t } = useTranslation();
  const statusByTool = indexByTool(useCliStatus().data);
  const { hydrationStatus, launchSession } = usePtyWorkspace();

  return (
    <>
      {TOOLS.map((tool) => {
        const ToolIcon = tool.icon;
        const available = statusByTool[tool.key]?.status === "available";
        return (
          <button
            key={tool.key}
            type="button"
            className="icon-button window-titlebar-action-button"
            title={t("projectDetail.launchTool", { tool: tool.label })}
            aria-label={t("projectDetail.launchTool", { tool: tool.label })}
            disabled={
              !available || directoryId == null || hydrationStatus !== "ready"
            }
            onClick={() => {
              if (directoryId != null) launchSession(directoryId, tool.key);
            }}
          >
            <ToolIcon size={16} />
          </button>
        );
      })}
    </>
  );
}

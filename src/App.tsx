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
import { Toaster, toast } from "sonner";
import { FolderOpen, PanelLeft, PanelRight, Plus } from "lucide-react";
import { AppLogo } from "./components/AppLogo";
import { AppTitlebarUtilities } from "./components/AppTitlebarUtilities";
import { WorkspaceDataRestoreListener } from "./components/WorkspaceDataRestoreListener";
import { StartupNotices } from "./components/StartupNotices";
import { Sidebar } from "./components/Sidebar";
import { ProjectMaintenanceDialog } from "./components/ProjectMaintenanceDialog";
import {
  type AppErrorState,
  formatAppErrorState,
  toAppErrorState,
} from "./lib/appErrors";
import { parseExitRequestedPayload } from "./lib/exitRequest";
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
import { onInboxEvent } from "./lib/windowInbox";
import { ImpactTitleList } from "./components/ImpactTitleList";
import { ImpactDialogActions } from "./components/ImpactDialogActions";
import { summarizeExitImpacts } from "./workspace/impacts/impactSummary";
import {
  collectAppExitImpacts,
  shouldExitWithoutPrompt,
  type AppExitRequest,
} from "./lib/appExitImpacts";
import { useDirectories } from "./hooks/queries";
import { TOOLS } from "./lib/tools";
import { windowRouteOf } from "./lib/windowKinds";
import { RUST_EVENTS } from "./lib/eventNames";
import {
  readFileLaunchParams,
  readPtyLaunchParams,
} from "./workspace/windows/windowLaunchParams";

export function App() {
  const { t } = useTranslation();
  useThemeSync();
  const route = windowRouteOf(getCurrentWindow().label);
  const search = new URLSearchParams(window.location.search);
  const fileParams =
    route === "workspace-content" ? readFileLaunchParams(search) : null;
  if (fileParams) {
    return (
      <Suspense fallback={null}>
        <StandaloneWorkspaceFileWindow
          documentId={fileParams.documentId}
          token={fileParams.windowToken}
          sourcePaneId={fileParams.sourcePaneId}
        />
      </Suspense>
    );
  }
  const ptyParams = route === "terminal" ? readPtyLaunchParams(search) : null;
  if (ptyParams) {
    return (
      <Suspense fallback={null}>
        <StandalonePtyWindow
          sessionId={ptyParams.sessionId}
          handoffToken={ptyParams.handoffToken}
          instanceId={ptyParams.instanceId}
          sourcePaneId={ptyParams.sourcePaneId}
          toolKey={ptyParams.toolKey}
          title={ptyParams.title ?? t("pty.detachedDefaultTitle")}
        />
      </Suspense>
    );
  }
  if (route !== "main") return null;
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
  const {
    collectExitImpacts,
    saveFiles,
    fileDocuments,
    fileBuffers,
    detachedFileIds,
    hydrationStatus,
  } = usePtyWorkspace();
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
  const [exitSaving, setExitSaving] = useState(false);
  const [exitError, setExitError] = useState<AppErrorState | null>(null);
  // 最近一次有效退出请求的 id：确认时只回传它，过期请求的异步结果据此丢弃。
  const exitRequestIdRef = useRef<string | null>(null);
  useExecutionTaskEvents();

  useLayoutEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onInboxEvent<unknown>(RUST_EVENTS.appExitRequested, (event) => {
      // 订阅返回前冲刷的缓冲消息会先到达已卸载的 effect（StrictMode 双挂载同理）。
      if (disposed) return;
      const payload = parseExitRequestedPayload(event.payload);
      if (!payload) {
        console.warn("app.exit_request_invalid", event.payload);
        return;
      }
      const { requestId, ptyCount, executionTaskCount } = payload;
      exitRequestIdRef.current = requestId;
      // 新请求取代旧请求：先收起旧对话框，并解除旧确认的“终止中”，使屏幕上的内容
      // 始终对应后端当前的待决请求；旧确认的结果会各自结束，不再影响新对话框。
      setExitRequest(null);
      setExitPending(false);
      setExitError(null);
      void collectExitImpacts(ptyCount)
        .then(async (collected) => {
          if (exitRequestIdRef.current !== requestId) return;
          const impacts: AppExitRequest = {
            ...collected,
            requestId,
            executionTaskCount,
          };
          if (shouldExitWithoutPrompt(impacts)) {
            setExitPending(true);
            try {
              await confirmAppExit(requestId);
            } catch (error) {
              // 无论是否已过期，这次确认都已结束：先解除“终止中”，否则新请求的对话框会被禁用。
              setExitPending(false);
              // 过期请求的失败不得覆盖当前对话框（R-EXIT-1）。
              if (exitRequestIdRef.current !== requestId) return;
              // 后端拒绝静默退出（例如检查之后又启动了 PTY）：恢复为可操作的对话框，
              // 不能停在“终止中”让两个按钮都被禁用。
              setExitRequest(impacts);
              setExitError(toAppErrorState(error));
            }
            return;
          }
          setExitRequest(impacts);
        })
        .catch((error) => {
          if (exitRequestIdRef.current !== requestId) return;
          console.error("Unable to collect application exit impacts", error);
          const current = exitStateRef.current;
          setExitRequest({
            ...collectAppExitImpacts({
              ptyCount,
              documents: current.fileDocuments,
              buffers: current.fileBuffers,
              uncertainDocumentIds: current.detachedFileIds,
            }),
            requestId,
            executionTaskCount,
          });
          setExitError(toAppErrorState(error));
        });
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
  }, [collectExitImpacts]);

  // requestId 必须来自对话框展示的那次请求（exitRequest.requestId），不得读取最新收到的请求。
  const quitWithActiveSessions = async (requestId: string) => {
    setExitPending(true);
    setExitError(null);
    try {
      await confirmAppExit(requestId);
    } catch (error) {
      setExitPending(false);
      // 确认的请求已被新请求取代：失败只属于旧对话框，不得显示在新对话框上。
      if (exitRequestIdRef.current !== requestId) return;
      setExitError(toAppErrorState(error));
    }
  };

  // m6-108：保存全部未保存的文件；全部成功后才退出。保存期间若出现新的退出请求，结果不再影响新对话框。
  const saveAllAndQuit = async (request: AppExitRequest) => {
    setExitSaving(true);
    setExitError(null);
    let remaining: string[];
    try {
      remaining = await saveFiles(
        request.dirtyFiles.map((file) => file.documentId),
      );
    } finally {
      setExitSaving(false);
    }
    if (exitRequestIdRef.current !== request.requestId) return;
    if (remaining.length > 0) {
      const stillUnsaved = new Set(remaining);
      setExitRequest((current) =>
        current && current.requestId === request.requestId
          ? {
              ...current,
              dirtyFiles: current.dirtyFiles.filter((file) =>
                stillUnsaved.has(file.documentId),
              ),
            }
          : current,
      );
      toast.error(
        t("workspaceFiles.saveAllFailedQuit", { count: remaining.length }),
      );
      return;
    }
    await quitWithActiveSessions(request.requestId);
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

  const exitSummary = exitRequest
    ? summarizeExitImpacts(exitRequest)
    : summarizeExitImpacts({
        ptyCount: 0,
        executionTaskCount: 0,
        dirtyFiles: [],
      });
  return (
    <>
      <WorkspaceDataRestoreListener />
      <StartupNotices ready={hydrationStatus !== "loading"} />
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
            {exitSummary.dirtyFiles.length > 0 && (
              <>
                <p>
                  {t("appExit.unsavedDescription", {
                    count: exitSummary.dirtyFiles.length,
                  })}
                </p>
                <ImpactTitleList items={exitSummary.dirtyFiles} />
              </>
            )}
            {exitError && (
              <p className="error">{formatAppErrorState(exitError, t)}</p>
            )}
            <ImpactDialogActions
              hasUnsavedFiles={exitSummary.dirtyFiles.length > 0}
              busy={exitPending || exitSaving}
              confirming={exitPending}
              labels={{
                cancel: t("common.cancel"),
                confirm: t("appExit.confirmDiscard"),
                confirmBusy: t("appExit.terminating"),
                saveAll: t("appExit.saveAllAndQuit"),
                saveAllBusy: t("workspaceFiles.saveAllInProgress"),
                discard: t("appExit.confirmDiscard"),
              }}
              onCancel={() => setExitRequest(null)}
              onConfirm={() =>
                void quitWithActiveSessions(exitRequest.requestId)
              }
              onSaveAll={() => void saveAllAndQuit(exitRequest)}
            />
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

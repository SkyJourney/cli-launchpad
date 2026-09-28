import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Check,
  FolderOpen,
  PanelRight,
  Pencil,
  RefreshCw,
  RotateCcw,
  Undo2,
  X,
} from "lucide-react";
import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDirectory } from "../hooks/queries";
import { indexByTool, useCliStatus } from "../hooks/useCliStatus";
import { formatRelativeMs } from "../lib/format";
import { qk } from "../lib/queryKeys";
import { TOOLS } from "../lib/tools";
import {
  deleteSessionAlias,
  listSessionPage,
  openProjectDirectory,
  setSessionAlias,
  type SessionPage,
  type PtySession,
  type SessionInfo,
  type ToolKey,
} from "../lib/tauri";
import { useAppStore } from "../store/appStore";
import { PtyTerminal, type PtyTerminalHandle } from "../components/PtyTerminal";

interface ProjectDetailViewProps {
  directoryId: number;
  active: boolean;
}

export function ProjectDetailView({
  directoryId: requestedDirectoryId,
  active,
}: ProjectDetailViewProps) {
  const { t, i18n } = useTranslation();
  const contextPanelOpen = useAppStore((state) => state.contextPanelOpen);
  const setContextPanelOpen = useAppStore((state) => state.setContextPanelOpen);
  const recordPtySession = useAppStore((state) => state.setPtySession);
  const queryClient = useQueryClient();

  const directory = useDirectory(requestedDirectoryId);
  const statusByTool = indexByTool(useCliStatus().data);
  const [openPathError, setOpenPathError] = useState<string | null>(null);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [aliasDraft, setAliasDraft] = useState("");
  const [aliasError, setAliasError] = useState<string | null>(null);
  const [ptySession, setPtySession] = useState<PtySession | null>(null);
  const [ptyStarting, setPtyStarting] = useState(false);
  const ptyTerminalRef = useRef<PtyTerminalHandle>(null);

  useEffect(() => {
    const narrowViewport = window.matchMedia("(max-width: 1120px)");
    if (narrowViewport.matches) setContextPanelOpen(false);
    const closeForNarrowViewport = (event: MediaQueryListEvent) => {
      if (event.matches) setContextPanelOpen(false);
    };
    narrowViewport.addEventListener("change", closeForNarrowViewport);
    return () =>
      narrowViewport.removeEventListener("change", closeForNarrowViewport);
  }, [setContextPanelOpen]);

  const directoryId = directory?.id ?? null;
  const claudeSessions = useProjectSessions(directoryId, active, "claude");
  const codexSessions = useProjectSessions(directoryId, active, "codex");
  const antigravitySessions = useProjectSessions(
    directoryId,
    active,
    "antigravity",
  );
  const sessionQueries = [
    claudeSessions,
    codexSessions,
    antigravitySessions,
  ] as const;
  const sessionItems = sessionQueries
    .flatMap((query) => query.data?.pages.flatMap((page) => page.items) ?? [])
    .sort((left, right) => (right.lastActiveMs ?? 0) - (left.lastActiveMs ?? 0));
  const sessionsLoading = sessionQueries.some((query) => query.isLoading);
  const sessionsFetching = sessionQueries.some((query) => query.isFetching);
  const sessionsError = sessionQueries.find((query) => query.isError);
  const sessionsHaveNextPage = sessionQueries.some((query) => query.hasNextPage);
  const sessionsFetchingNextPage = sessionQueries.some(
    (query) => query.isFetchingNextPage,
  );
  const sessionsNextPageError = sessionQueries.find(
    (query) => query.isFetchNextPageError,
  );

  const openPathMutation = useMutation({
    mutationFn: () => openProjectDirectory(directoryId as number),
    onError: (error) => setOpenPathError(String(error)),
  });

  const aliasMutation = useMutation({
    mutationFn: (variables: {
      directoryId: number;
      toolKey: ToolKey;
      sessionId: string;
      alias: string | null;
    }) =>
      variables.alias == null
        ? deleteSessionAlias(
            variables.directoryId,
            variables.toolKey,
            variables.sessionId,
          )
        : setSessionAlias(
            variables.directoryId,
            variables.toolKey,
            variables.sessionId,
            variables.alias,
          ),
    onSuccess: (_result, variables) => {
      const queryKey = qk.sessions(variables.directoryId, variables.toolKey);
      queryClient.setQueryData<InfiniteData<SessionPage, string | null>>(
        queryKey,
        (current) =>
          current
            ? {
                ...current,
                pages: current.pages.map((page) => ({
                  ...page,
                  items: page.items.map((session) =>
                    session.sessionId === variables.sessionId
                      ? { ...session, alias: variables.alias }
                      : session,
                  ),
                })),
              }
            : current,
      );
      setEditingSessionId(null);
      setAliasDraft("");
      setAliasError(null);
      void queryClient.invalidateQueries({ queryKey, exact: true });
    },
    onError: (error) => setAliasError(String(error)),
  });

  const anyPending = ptyStarting;

  if (!directory) {
    return (
      <div className="detail-view workbench-project project-detail-loading">
        <p className="muted">{t("projectDetail.noDirectory")}</p>
      </div>
    );
  }

  const runEmbeddedLaunch = async (
    toolKey: ToolKey,
    resumeSessionId?: string,
  ) => {
    if (
      !directoryId ||
      statusByTool[toolKey]?.status !== "available" ||
      ptySession?.state === "running" ||
      ptyStarting
    ) {
      return;
    }
    setPtyStarting(true);
    try {
      await ptyTerminalRef.current?.startSession(
        directoryId,
        toolKey,
        resumeSessionId,
      );
    } finally {
      setPtyStarting(false);
    }
  };
  const runResume = (session: SessionInfo) =>
    void runEmbeddedLaunch(session.toolKey, session.sessionId);
  const refreshSessions = () => {
    for (const tool of TOOLS) {
      const queryKey = qk.sessions(directoryId, tool.key);
      queryClient.setQueryData<InfiniteData<SessionPage, string | null>>(
        queryKey,
        (current) =>
          current
            ? {
                pages: current.pages.slice(0, 1),
                pageParams: current.pageParams.slice(0, 1),
              }
            : current,
      );
      void queryClient.invalidateQueries({ queryKey, exact: true });
    }
  };
  const beginRename = (session: SessionInfo, currentTitle: string) => {
    setEditingSessionId(`${session.toolKey}:${session.sessionId}`);
    setAliasDraft(currentTitle);
    setAliasError(null);
  };
  const cancelRename = () => {
    setEditingSessionId(null);
    setAliasDraft("");
    setAliasError(null);
  };
  const saveAlias = (session: SessionInfo) => {
    const alias = aliasDraft.trim();
    if (!alias) {
      setAliasError(t("projectDetail.aliasRequired"));
      return;
    }
    aliasMutation.mutate({
      directoryId: directory.id,
      toolKey: session.toolKey,
      sessionId: session.sessionId,
      alias,
    });
  };
  const restoreOriginalTitle = (session: SessionInfo) => {
    setAliasError(null);
    aliasMutation.mutate({
      directoryId: directory.id,
      toolKey: session.toolKey,
      sessionId: session.sessionId,
      alias: null,
    });
  };

  return (
    <div
      className={clsx("detail-view workbench-project", {
        "context-open": contextPanelOpen,
      })}
    >
      <section
        className="detail-terminal-column"
        aria-label={t("pty.panelLabel")}
      >
        {!contextPanelOpen && (
          <button
            type="button"
            className="icon-button context-panel-reopen"
            title={t("projectDetail.showContextPanel")}
            aria-label={t("projectDetail.showContextPanel")}
            aria-expanded={false}
            onClick={() => setContextPanelOpen(true)}
          >
            <PanelRight size={16} />
          </button>
        )}
        <PtyTerminal
          ref={ptyTerminalRef}
          onSessionChange={(session) => {
            recordPtySession(requestedDirectoryId, session)
            if (session) {
              void queryClient.invalidateQueries({ queryKey: qk.directories() });
            }
          }}
        />
      </section>

      <aside
        className="project-context-panel"
        aria-label={t("projectDetail.context")}
        aria-hidden={!contextPanelOpen}
      >
        <header className="project-context-header">
          <div>
            <h2>{t("projectDetail.context")}</h2>
            <span>{directory.name}</span>
          </div>
          <div className="project-context-header-actions">
            <button
              type="button"
              className="icon-button"
              title={t("projectDetail.openDirectory")}
              aria-label={t("projectDetail.openDirectory")}
              disabled={openPathMutation.isPending}
              onClick={() => {
                setOpenPathError(null);
                openPathMutation.mutate();
              }}
            >
              <FolderOpen size={15} />
            </button>
            <button
              type="button"
              className="icon-button"
              title={t("projectDetail.hideContextPanel")}
              aria-label={t("projectDetail.hideContextPanel")}
              onClick={() => setContextPanelOpen(false)}
            >
              <PanelRight size={16} />
            </button>
          </div>
        </header>
        <div className="project-context-body">
          {openPathError && (
            <p className="error">
              {t("projectDetail.openPathFailed", { error: openPathError })}
            </p>
          )}

          <section className="project-context-section">
            <div className="section-heading">
              {t("projectDetail.cliLaunchers")}
            </div>
            <div
              className="cli-launcher-list"
              role="group"
              aria-label={t("projectDetail.cliLaunchers")}
            >
              {TOOLS.map((tool) => {
                const status = statusByTool[tool.key]?.status ?? "missing";
                const available = status === "available";
                const ToolIcon = tool.icon;
                return (
                  <button
                    key={tool.key}
                    type="button"
                    className="cli-launch-button"
                    title={t(
                      available
                        ? "cliStatus.availableTitle"
                        : "cliStatus.missingTitle",
                    )}
                    aria-label={t("projectDetail.launchTool", { tool: tool.label })}
                    disabled={
                      !available ||
                      anyPending ||
                      ptySession?.state === "running"
                    }
                    onClick={() => {
                      cancelRename();
                      void runEmbeddedLaunch(tool.key);
                    }}
                  >
                    <ToolIcon size={17} />
                    {tool.label}
                    <span
                      className={clsx("tab-dot", `dot-${status}`)}
                      aria-hidden="true"
                    />
                  </button>
                );
              })}
            </div>
          </section>

          <section className="project-context-section">
            <div className="section-heading heading-actions">
              <span>{t("projectDetail.sessions")}</span>
              <button
                className="icon-button refresh-button"
                title={t("projectDetail.refreshSessions")}
                disabled={sessionsFetching}
                onClick={refreshSessions}
              >
                <RefreshCw
                  size={14}
                  className={sessionsFetching ? "spinning" : undefined}
                />
              </button>
            </div>
            {sessionsError && sessionItems.length === 0 ? (
              <p className="error">
                {t("projectDetail.sessionsFailed", {
                  error: String(sessionsError.error),
                })}
              </p>
            ) : sessionsLoading && sessionItems.length === 0 ? (
              <p className="muted">{t("projectDetail.reading")}</p>
            ) : sessionItems.length > 0 ? (
              <div className="session-history">
                <ul className="session-list">
                  {sessionItems.map((session) => {
                    const editing =
                      editingSessionId ===
                      `${session.toolKey}:${session.sessionId}`;
                    const displayTitle = session.alias ?? session.title;
                    const sessionTool = TOOLS.find(
                      (tool) => tool.key === session.toolKey,
                    )!;
                    const SessionToolIcon = sessionTool.icon;
                    return (
                      <li
                        className="session-row"
                        key={`${session.toolKey}:${session.sessionId}`}
                      >
                        <div className="session-meta">
                          <span className="session-tool-label">
                            <SessionToolIcon size={14} />
                            {sessionTool.label}
                          </span>
                          {editing ? (
                            <input
                              autoFocus
                              className="session-alias-input"
                              aria-label={t("projectDetail.sessionAlias")}
                              maxLength={100}
                              value={aliasDraft}
                              onChange={(event) => {
                                setAliasDraft(event.target.value);
                                setAliasError(null);
                              }}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  saveAlias(session);
                                } else if (event.key === "Escape") {
                                  cancelRename();
                                }
                              }}
                            />
                          ) : (
                            <span
                              className="session-title"
                              title={
                                session.alias
                                  ? t("projectDetail.originalTitle", {
                                      title: session.title,
                                    })
                                  : session.title
                              }
                            >
                              {displayTitle}
                            </span>
                          )}
                          <span className="muted">
                            {formatRelativeMs(
                              session.lastActiveMs,
                              i18n.resolvedLanguage,
                              t("time.unknown"),
                            )}
                            {session.alias
                              ? ` · ${t("projectDetail.customTitle")}`
                              : ""}
                          </span>
                          {editing && aliasError && (
                            <span className="error session-alias-error">
                              {aliasError}
                            </span>
                          )}
                        </div>
                        <div className="session-actions">
                          {editing ? (
                            <>
                              <button
                                className="icon-button"
                                title={t("projectDetail.saveAlias")}
                                aria-label={t("projectDetail.saveAlias")}
                                disabled={aliasMutation.isPending}
                                onClick={() => saveAlias(session)}
                              >
                                <Check size={14} />
                              </button>
                              <button
                                className="icon-button"
                                title={t("projectDetail.cancelRename")}
                                aria-label={t("projectDetail.cancelRename")}
                                disabled={aliasMutation.isPending}
                                onClick={cancelRename}
                              >
                                <X size={14} />
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                className="icon-button"
                                title={t("projectDetail.renameSession")}
                                aria-label={t("projectDetail.renameSession")}
                                disabled={aliasMutation.isPending}
                                onClick={() =>
                                  beginRename(session, displayTitle)
                                }
                              >
                                <Pencil size={14} />
                              </button>
                              {session.alias && (
                                <button
                                  className="icon-button"
                                  title={t("projectDetail.restoreOriginal")}
                                  aria-label={t(
                                    "projectDetail.restoreOriginal",
                                  )}
                                  disabled={aliasMutation.isPending}
                                  onClick={() =>
                                    restoreOriginalTitle(session)
                                  }
                                >
                                  <Undo2 size={14} />
                                </button>
                              )}
                            </>
                          )}
                          <button
                            className="ghost-button"
                            disabled={
                              statusByTool[session.toolKey]?.status !==
                                "available" ||
                              anyPending ||
                              ptySession?.state === "running" ||
                              editing
                            }
                            onClick={() => runResume(session)}
                          >
                            <RotateCcw size={14} />
                            {t("projectDetail.resumeEmbedded")}
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
                {sessionsNextPageError && (
                  <p className="error session-page-error">
                    {t("projectDetail.loadMoreFailed", {
                      error: String(sessionsNextPageError.error),
                    })}
                  </p>
                )}
                {sessionsHaveNextPage && (
                  <button
                    className="ghost-button session-load-more"
                    disabled={sessionsFetchingNextPage}
                    onClick={() => {
                      void Promise.all(
                        sessionQueries
                          .filter((query) => query.hasNextPage)
                          .map((query) => query.fetchNextPage()),
                      );
                    }}
                  >
                    {sessionsFetchingNextPage
                      ? t("common.loading")
                      : t("common.more")}
                  </button>
                )}
              </div>
            ) : (
              <p className="muted">{t("projectDetail.noSessions")}</p>
            )}
          </section>

        </div>
      </aside>
    </div>
  );
}

function useProjectSessions(
  directoryId: number | null,
  enabled: boolean,
  toolKey: ToolKey,
) {
  return useInfiniteQuery({
    queryKey: qk.sessions(directoryId, toolKey),
    queryFn: ({ pageParam }) =>
      listSessionPage(directoryId as number, toolKey, pageParam, 10),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: enabled && directoryId != null,
  });
}

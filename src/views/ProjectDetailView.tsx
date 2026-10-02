import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQuery,
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
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDirectory } from "../hooks/queries";
import { indexByTool, useCliStatus } from "../hooks/useCliStatus";
import { formatRelativeMs } from "../lib/format";
import { qk } from "../lib/queryKeys";
import {
  getVisibleSearchResults,
  hasMoreSearchResults,
  nextSearchVisibleCount,
  shouldRefreshSessionSearchIndex,
  shouldSearchSessions,
} from "../lib/sessionSearch";
import { TOOLS } from "../lib/tools";
import {
  deleteSessionAlias,
  listSessionPage,
  openProjectDirectory,
  refreshSessionSearchIndex,
  searchSessions,
  setSessionAlias,
  type SessionPage,
  type SessionInfo,
  type ToolKey,
} from "../lib/tauri";
import { useAppStore } from "../store/appStore";
import { usePtyWorkspace } from "../components/PtyWorkspace";
import { SearchInput } from "../components/SearchInput";
import { ThemedScrollArea } from "../components/ThemedScrollArea";

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
  const launchSession = usePtyWorkspace().launchSession;
  const queryClient = useQueryClient();

  const directory = useDirectory(requestedDirectoryId);
  const statusByTool = indexByTool(useCliStatus().data);
  const [openPathError, setOpenPathError] = useState<string | null>(null);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [aliasDraft, setAliasDraft] = useState("");
  const [aliasError, setAliasError] = useState<string | null>(null);
  const [sessionSearch, setSessionSearch] = useState("");
  const [debouncedSessionSearch, setDebouncedSessionSearch] = useState("");
  const [visibleSearchCount, setVisibleSearchCount] = useState(10);
  const [sessionQueriesByTool, setSessionQueriesByTool] = useState<
    Partial<Record<ToolKey, ProjectSessionQuerySnapshot>>
  >({});
  const [previousDirectoryId, setPreviousDirectoryId] = useState<number | null>(
    null,
  );

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
  const projectChanged = previousDirectoryId !== directoryId;
  const normalizedSessionSearch = sessionSearch.trim();
  const searchingSessions = normalizedSessionSearch.length > 0;
  const handleSessionQueryChange = useCallback(
    (toolKey: ToolKey, query: ProjectSessionQuerySnapshot) => {
      setSessionQueriesByTool((current) => ({ ...current, [toolKey]: query }));
    },
    [],
  );
  const sessionQueries = TOOLS.flatMap((tool) => {
    const query = sessionQueriesByTool[tool.key];
    return query?.directoryId === directoryId ? [query] : [];
  });
  const searchIndexQuery = useQuery({
    queryKey: qk.sessionSearchIndex(directoryId),
    queryFn: () => refreshSessionSearchIndex(directoryId as number),
    enabled: shouldRefreshSessionSearchIndex(
      active && !projectChanged,
      directoryId,
    ),
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const searchReady =
    normalizedSessionSearch === debouncedSessionSearch &&
    !projectChanged &&
    searchIndexQuery.isSuccess &&
    !searchIndexQuery.isFetching;
  const sessionSearchQuery = useQuery({
    queryKey: qk.sessionSearch(
      directoryId,
      debouncedSessionSearch,
      searchIndexQuery.dataUpdatedAt,
    ),
    queryFn: () =>
      searchSessions(directoryId as number, debouncedSessionSearch),
    enabled: shouldSearchSessions({
      active,
      projectChanged,
      directoryId,
      indexReady: searchIndexQuery.isSuccess && !searchIndexQuery.isFetching,
      query: debouncedSessionSearch,
    }),
    staleTime: Infinity,
    gcTime: 0,
  });
  const regularSessionItems = sessionQueries
    .flatMap((query) => query.data?.pages.flatMap((page) => page.items) ?? [])
    .sort(
      (left, right) => (right.lastActiveMs ?? 0) - (left.lastActiveMs ?? 0),
    );
  const regularSessionsLoading = sessionQueries.some(
    (query) => query.isLoading,
  );
  const regularSessionsFetching = sessionQueries.some(
    (query) => query.isFetching,
  );
  const regularSessionsError = sessionQueries.find((query) => query.isError);
  const regularSessionsHaveNextPage = sessionQueries.some(
    (query) => query.hasNextPage,
  );
  const regularSessionsFetchingNextPage = sessionQueries.some(
    (query) => query.isFetchingNextPage,
  );
  const regularSessionsNextPageError = sessionQueries.find(
    (query) => query.isFetchNextPageError,
  );
  const searchSessionItems = sessionSearchQuery.data?.items ?? [];
  const sessionItems = searchingSessions
    ? searchReady
      ? getVisibleSearchResults(searchSessionItems, visibleSearchCount)
      : []
    : regularSessionItems;
  const sessionsLoading = searchingSessions
    ? !searchReady || searchIndexQuery.isLoading || sessionSearchQuery.isLoading
    : regularSessionsLoading ||
      (active && sessionQueries.length < TOOLS.length);
  const sessionsFetching =
    regularSessionsFetching ||
    searchIndexQuery.isFetching ||
    sessionSearchQuery.isFetching;
  const sessionsError = searchingSessions
    ? (searchIndexQuery.error ?? sessionSearchQuery.error)
    : regularSessionsError?.error;
  const sessionsHaveNextPage = searchingSessions
    ? searchReady &&
      hasMoreSearchResults(searchSessionItems, visibleSearchCount)
    : regularSessionsHaveNextPage;
  const sessionsFetchingNextPage = searchingSessions
    ? false
    : regularSessionsFetchingNextPage;
  const sessionsNextPageError = searchingSessions
    ? null
    : regularSessionsNextPageError?.error;
  const incompleteSearchTools = sessionSearchQuery.data?.incompleteTools ?? [];

  useEffect(() => {
    const timeout = window.setTimeout(
      () => setDebouncedSessionSearch(normalizedSessionSearch),
      250,
    );
    return () => window.clearTimeout(timeout);
  }, [normalizedSessionSearch]);

  useEffect(() => {
    if (previousDirectoryId === directoryId) return;
    const previousId = previousDirectoryId;
    if (previousId != null && previousId !== directoryId) {
      queryClient.removeQueries({
        queryKey: qk.sessionSearches(previousId),
        exact: false,
      });
    }
    setPreviousDirectoryId(directoryId);
    setSessionSearch("");
    setDebouncedSessionSearch("");
    setVisibleSearchCount(10);
  }, [directoryId, previousDirectoryId, queryClient]);

  useEffect(() => {
    setVisibleSearchCount(10);
    if (normalizedSessionSearch) return;

    setDebouncedSessionSearch("");
    if (directoryId != null) {
      queryClient.removeQueries({
        queryKey: qk.sessionSearches(directoryId),
        exact: false,
      });
    }
  }, [directoryId, normalizedSessionSearch, queryClient]);

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
      void queryClient.invalidateQueries({
        queryKey: qk.sessionSearches(variables.directoryId),
        exact: false,
      });
    },
    onError: (error) => setAliasError(String(error)),
  });

  if (!directory) {
    return (
      <aside className="project-context-panel project-detail-loading">
        <p className="muted">{t("projectDetail.noDirectory")}</p>
      </aside>
    );
  }

  const runEmbeddedLaunch = (toolKey: ToolKey, resumeSessionId?: string) => {
    if (!directoryId || statusByTool[toolKey]?.status !== "available") {
      return;
    }
    launchSession(directoryId, toolKey, resumeSessionId);
  };
  const runResume = (session: SessionInfo) =>
    runEmbeddedLaunch(session.toolKey, session.sessionId);
  const refreshSessions = () => {
    const refreshIndex = searchIndexQuery.refetch();
    if (normalizedSessionSearch) {
      void refreshIndex.then(() =>
        queryClient.invalidateQueries({
          queryKey: qk.sessionSearches(directoryId),
          exact: false,
        }),
      );
      return;
    }
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
    <aside
      className="project-context-panel"
      aria-label={t("projectDetail.context")}
      aria-hidden={!contextPanelOpen}
    >
      {TOOLS.map((tool) => (
        <ProjectSessionQuery
          key={tool.key}
          directoryId={directoryId}
          enabled={active && !searchingSessions}
          toolKey={tool.key}
          onChange={handleSessionQueryChange}
        />
      ))}
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
      <ThemedScrollArea
        className="project-context-scroll-area"
        viewportClassName="project-context-body"
        viewportProps={{
          role: "region",
          "aria-label": t("projectDetail.context"),
          tabIndex: 0,
        }}
      >
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
              const status = statusByTool[tool.key]?.status ?? "unknown";
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
                      : status === "unknown"
                        ? "cliStatus.unknownTitle"
                        : "cliStatus.missingTitle",
                  )}
                  aria-label={t("projectDetail.launchTool", {
                    tool: tool.label,
                  })}
                  disabled={!available}
                  onClick={() => {
                    cancelRename();
                    runEmbeddedLaunch(tool.key);
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
          <SearchInput
            className="session-history-search"
            value={sessionSearch}
            onChange={setSessionSearch}
            placeholder={t("projectDetail.searchPlaceholder")}
            ariaLabel={t("projectDetail.searchSessions")}
            maxLength={200}
            onClear={() => setSessionSearch("")}
            clearLabel={t("projectDetail.clearSearch")}
          />
          {searchingSessions &&
            searchReady &&
            incompleteSearchTools.length > 0 && (
              <p className="muted session-search-warning">
                {t("projectDetail.searchIncomplete", {
                  tools: incompleteSearchTools
                    .map(
                      (toolKey) =>
                        TOOLS.find((tool) => tool.key === toolKey)?.label ??
                        toolKey,
                    )
                    .join(", "),
                })}
              </p>
            )}
          {sessionsError && sessionItems.length === 0 ? (
            <p className="error">
              {t(
                searchingSessions
                  ? "projectDetail.searchFailed"
                  : "projectDetail.sessionsFailed",
                {
                  error: String(sessionsError),
                },
              )}
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
                              onClick={() => beginRename(session, displayTitle)}
                            >
                              <Pencil size={14} />
                            </button>
                            {session.alias && (
                              <button
                                className="icon-button"
                                title={t("projectDetail.restoreOriginal")}
                                aria-label={t("projectDetail.restoreOriginal")}
                                disabled={aliasMutation.isPending}
                                onClick={() => restoreOriginalTitle(session)}
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
                              "available" || editing
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
                    error: String(sessionsNextPageError),
                  })}
                </p>
              )}
              {sessionsHaveNextPage && (
                <button
                  className="ghost-button session-load-more"
                  disabled={sessionsFetchingNextPage}
                  onClick={() => {
                    if (searchingSessions) {
                      setVisibleSearchCount(nextSearchVisibleCount);
                    } else {
                      void Promise.all(
                        sessionQueries
                          .filter((query) => query.hasNextPage)
                          .map((query) => query.fetchNextPage()),
                      );
                    }
                  }}
                >
                  {sessionsFetchingNextPage
                    ? t("common.loading")
                    : t("common.more")}
                </button>
              )}
            </div>
          ) : (
            <p className="muted">
              {searchingSessions
                ? t("projectDetail.noSearchResults")
                : t("projectDetail.noSessions")}
            </p>
          )}
        </section>
      </ThemedScrollArea>
    </aside>
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

type ProjectSessionQuerySnapshot = Pick<
  ReturnType<typeof useProjectSessions>,
  | "data"
  | "error"
  | "isError"
  | "isLoading"
  | "isFetching"
  | "hasNextPage"
  | "isFetchingNextPage"
  | "isFetchNextPageError"
  | "fetchNextPage"
> & { directoryId: number | null };

function ProjectSessionQuery({
  directoryId,
  enabled,
  toolKey,
  onChange,
}: {
  directoryId: number | null;
  enabled: boolean;
  toolKey: ToolKey;
  onChange: (toolKey: ToolKey, query: ProjectSessionQuerySnapshot) => void;
}) {
  const query = useProjectSessions(directoryId, enabled, toolKey);
  useEffect(() => {
    onChange(toolKey, {
      directoryId,
      data: query.data,
      error: query.error,
      isError: query.isError,
      isLoading: query.isLoading,
      isFetching: query.isFetching,
      hasNextPage: query.hasNextPage,
      isFetchingNextPage: query.isFetchingNextPage,
      isFetchNextPageError: query.isFetchNextPageError,
      fetchNextPage: query.fetchNextPage,
    });
  }, [
    onChange,
    directoryId,
    query.data,
    query.error,
    query.fetchNextPage,
    query.hasNextPage,
    query.isError,
    query.isFetchNextPageError,
    query.isFetching,
    query.isFetchingNextPage,
    query.isLoading,
    toolKey,
  ]);
  return null;
}

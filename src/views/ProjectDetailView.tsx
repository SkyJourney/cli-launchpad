import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FolderOpen,
  Pencil,
  Play,
  RefreshCw,
  RotateCcw,
  Undo2,
  X,
} from "lucide-react";
import clsx from "clsx";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useDirectory } from "../hooks/queries";
import { indexByTool, useCliStatus } from "../hooks/useCliStatus";
import { copyText } from "../lib/clipboard";
import { formatRelativeMs } from "../lib/format";
import { qk } from "../lib/queryKeys";
import { TOOLS } from "../lib/tools";
import {
  launchTool,
  deleteSessionAlias,
  listSessionPage,
  openProjectDirectory,
  previewLaunch,
  resumeSession,
  setSessionAlias,
  type SessionPage,
  type ToolKey,
} from "../lib/tauri";
import { useAppStore } from "../store/appStore";

export function ProjectDetailView() {
  const { t, i18n } = useTranslation();
  const selectedDirectoryId = useAppStore((state) => state.selectedDirectoryId);
  const setView = useAppStore((state) => state.setView);
  const selectDirectory = useAppStore((state) => state.selectDirectory);
  const queryClient = useQueryClient();

  const directory = useDirectory(selectedDirectoryId);
  const statusByTool = indexByTool(useCliStatus().data);

  // Manual tab selection wins when still available; otherwise default to the
  // first available tool. Pure derivation — no effect, no stale closure.
  const [manualTool, setManualTool] = useState<ToolKey | null>(null);
  const firstAvailable = TOOLS.find(
    (tool) => statusByTool[tool.key]?.status === "available",
  )?.key;
  const manualValid =
    manualTool && statusByTool[manualTool]?.status === "available";
  const activeTool: ToolKey =
    (manualValid ? manualTool : firstAvailable) ?? TOOLS[0].key;

  const [showPreview, setShowPreview] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [openPathError, setOpenPathError] = useState<string | null>(null);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [aliasDraft, setAliasDraft] = useState("");
  const [aliasError, setAliasError] = useState<string | null>(null);

  const directoryId = directory?.id ?? null;
  const launchable = statusByTool[activeTool]?.status === "available";

  const sessions = useInfiniteQuery({
    queryKey: qk.sessions(directoryId, activeTool),
    queryFn: ({ pageParam }) =>
      listSessionPage(directoryId as number, activeTool, pageParam, 10),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: directoryId != null,
  });
  const sessionItems = sessions.data?.pages.flatMap((page) => page.items) ?? [];

  const preview = useQuery({
    queryKey: qk.preview(directoryId, activeTool),
    queryFn: () => previewLaunch(directoryId as number, activeTool),
    enabled: directoryId != null && showPreview,
  });

  const invalidateDirectories = () =>
    queryClient.invalidateQueries({ queryKey: qk.directories() });

  const launchMutation = useMutation({
    mutationFn: () => launchTool(directoryId as number, activeTool),
    onSuccess: invalidateDirectories,
    onError: (error) => setLaunchError(String(error)),
  });

  const resumeMutation = useMutation({
    mutationFn: (sessionId: string) =>
      resumeSession(directoryId as number, activeTool, sessionId),
    onSuccess: invalidateDirectories,
    onError: (error) => setLaunchError(String(error)),
  });

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

  const anyPending = launchMutation.isPending || resumeMutation.isPending;

  if (!directory) {
    return (
      <div className="detail-view">
        <button className="ghost-button" onClick={() => setView("projects")}>
          <ArrowLeft size={15} />
          {t("common.back")}
        </button>
        <p className="muted">{t("projectDetail.noDirectory")}</p>
      </div>
    );
  }

  const runLaunch = () => {
    setLaunchError(null);
    launchMutation.mutate();
  };
  const runResume = (sessionId: string) => {
    setLaunchError(null);
    resumeMutation.mutate(sessionId);
  };
  const refreshSessions = () => {
    const queryKey = qk.sessions(directoryId, activeTool);
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
  };
  const beginRename = (sessionId: string, currentTitle: string) => {
    setEditingSessionId(sessionId);
    setAliasDraft(currentTitle);
    setAliasError(null);
  };
  const cancelRename = () => {
    setEditingSessionId(null);
    setAliasDraft("");
    setAliasError(null);
  };
  const saveAlias = (sessionId: string) => {
    const alias = aliasDraft.trim();
    if (!alias) {
      setAliasError(t("projectDetail.aliasRequired"));
      return;
    }
    aliasMutation.mutate({
      directoryId: directory.id,
      toolKey: activeTool,
      sessionId,
      alias,
    });
  };
  const restoreOriginalTitle = (sessionId: string) => {
    setAliasError(null);
    aliasMutation.mutate({
      directoryId: directory.id,
      toolKey: activeTool,
      sessionId,
      alias: null,
    });
  };

  return (
    <div className="detail-view">
      <button className="ghost-button" onClick={() => setView("projects")}>
        <ArrowLeft size={15} />
        {t("common.back")}
      </button>

      <header className="detail-head detail-head-row">
        <div>
          <h1>{directory.name}</h1>
          <p className="muted">{directory.path}</p>
        </div>
        <div className="detail-actions">
          <button
            className="ghost-button"
            disabled={openPathMutation.isPending}
            onClick={() => {
              setOpenPathError(null);
              openPathMutation.mutate();
            }}
          >
            <FolderOpen size={15} />
            {t("projectDetail.openDirectory")}
          </button>
          <button
            className="ghost-button"
            onClick={() => {
              selectDirectory(directory.id);
              setView("edit");
            }}
          >
            <Pencil size={15} />
            {t("projectDetail.editArgs")}
          </button>
        </div>
      </header>
      {openPathError && (
        <p className="error">
          {t("projectDetail.openPathFailed", { error: openPathError })}
        </p>
      )}

      <div className="tab-row" role="tablist">
        {TOOLS.map((tool) => {
          const status = statusByTool[tool.key]?.status ?? "missing";
          const disabled = status === "missing";
          return (
            <button
              key={tool.key}
              role="tab"
              aria-selected={tool.key === activeTool}
              className={clsx("tab", { active: tool.key === activeTool })}
              disabled={disabled}
              onClick={() => {
                cancelRename();
                setManualTool(tool.key);
              }}
            >
              <tool.icon size={15} />
              {tool.label}
              <span className={clsx("tab-dot", `dot-${status}`)} />
            </button>
          );
        })}
      </div>

      <div className="launch-bar">
        <button
          className="primary-button"
          disabled={!launchable || anyPending}
          onClick={runLaunch}
        >
          <Play size={15} />
          {t("projectDetail.launchTool", {
            tool: TOOLS.find((tool) => tool.key === activeTool)?.label,
          })}
        </button>
        {!launchable && (
          <span className="muted">{t("projectDetail.unavailable")}</span>
        )}
      </div>
      {launchError && (
        <p className="error">
          {t("projectDetail.launchFailed", { error: launchError })}
        </p>
      )}

      <section>
        <div className="section-heading heading-actions">
          <span>{t("projectDetail.sessions")}</span>
          <button
            className="icon-button refresh-button"
            title={t("projectDetail.refreshSessions")}
            disabled={sessions.isFetching}
            onClick={refreshSessions}
          >
            <RefreshCw
              size={14}
              className={sessions.isFetching ? "spinning" : undefined}
            />
          </button>
        </div>
        {sessions.isError && sessionItems.length === 0 ? (
          <p className="error">
            {t("projectDetail.sessionsFailed", {
              error: String(sessions.error),
            })}
          </p>
        ) : sessions.isLoading ? (
          <p className="muted">{t("projectDetail.reading")}</p>
        ) : sessionItems.length > 0 ? (
          <div className="session-history">
            <ul className="session-list">
              {sessionItems.map((session) => {
                const editing = editingSessionId === session.sessionId;
                const displayTitle = session.alias ?? session.title;
                return (
                  <li className="session-row" key={session.sessionId}>
                    <div className="session-meta">
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
                              saveAlias(session.sessionId);
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
                            onClick={() => saveAlias(session.sessionId)}
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
                              beginRename(session.sessionId, displayTitle)
                            }
                          >
                            <Pencil size={14} />
                          </button>
                          {session.alias && (
                            <button
                              className="icon-button"
                              title={t("projectDetail.restoreOriginal")}
                              aria-label={t("projectDetail.restoreOriginal")}
                              disabled={aliasMutation.isPending}
                              onClick={() =>
                                restoreOriginalTitle(session.sessionId)
                              }
                            >
                              <Undo2 size={14} />
                            </button>
                          )}
                        </>
                      )}
                      <button
                        className="ghost-button"
                        disabled={!launchable || anyPending || editing}
                        onClick={() => runResume(session.sessionId)}
                      >
                        <RotateCcw size={14} />
                        {t("projectDetail.restore")}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
            {sessions.isFetchNextPageError && (
              <p className="error session-page-error">
                {t("projectDetail.loadMoreFailed", {
                  error: String(sessions.error),
                })}
              </p>
            )}
            {sessions.hasNextPage && (
              <button
                className="ghost-button session-load-more"
                disabled={sessions.isFetchingNextPage}
                onClick={() => void sessions.fetchNextPage()}
              >
                {sessions.isFetchingNextPage
                  ? t("common.loading")
                  : t("common.more")}
              </button>
            )}
          </div>
        ) : (
          <p className="muted">{t("projectDetail.noSessions")}</p>
        )}
      </section>

      <section className="command-preview">
        <button
          className="preview-toggle"
          onClick={() => setShowPreview((value) => !value)}
        >
          {showPreview ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          {t("projectDetail.commandPreview")}
        </button>
        {showPreview && (
          <div className="preview-body">
            <code>
              {preview.isError
                ? String(preview.error)
                : (preview.data ?? t("projectDetail.generating"))}
            </code>
            <button
              className="ghost-button"
              disabled={!preview.data}
              onClick={() => preview.data && void copyText(preview.data)}
            >
              <Copy size={14} />
              {t("common.copy")}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

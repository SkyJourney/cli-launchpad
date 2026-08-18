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
          返回
        </button>
        <p className="muted">未选择目录。</p>
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
      setAliasError("会话别名不能为空");
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
        返回
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
            打开目录
          </button>
          <button
            className="ghost-button"
            onClick={() => {
              selectDirectory(directory.id);
              setView("edit");
            }}
          >
            <Pencil size={15} />
            编辑参数
          </button>
        </div>
      </header>
      {openPathError && <p className="error">打开目录失败：{openPathError}</p>}

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
          启动 {TOOLS.find((t) => t.key === activeTool)?.label}
        </button>
        {!launchable && (
          <span className="muted">
            该 CLI 当前不可用，请前往设置检测或安装。
          </span>
        )}
      </div>
      {launchError && <p className="error">启动失败：{launchError}</p>}

      <section>
        <div className="section-heading heading-actions">
          <span>历史会话</span>
          <button
            className="icon-button"
            title="刷新会话"
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
          <p className="error">读取会话失败：{String(sessions.error)}</p>
        ) : sessions.isLoading ? (
          <p className="muted">读取中…</p>
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
                          aria-label="会话别名"
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
                              ? `原始标题：${session.title}`
                              : session.title
                          }
                        >
                          {displayTitle}
                        </span>
                      )}
                      <span className="muted">
                        {formatRelativeMs(session.lastActiveMs)}
                        {session.alias ? " · 自定义标题" : ""}
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
                            title="保存会话别名"
                            aria-label="保存会话别名"
                            disabled={aliasMutation.isPending}
                            onClick={() => saveAlias(session.sessionId)}
                          >
                            <Check size={14} />
                          </button>
                          <button
                            className="icon-button"
                            title="取消重命名"
                            aria-label="取消重命名"
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
                            title="重命名会话"
                            aria-label="重命名会话"
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
                              title="恢复原始标题"
                              aria-label="恢复原始标题"
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
                        恢复
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
            {sessions.isFetchNextPageError && (
              <p className="error session-page-error">
                加载更多失败：{String(sessions.error)}
              </p>
            )}
            {sessions.hasNextPage && (
              <button
                className="ghost-button session-load-more"
                disabled={sessions.isFetchingNextPage}
                onClick={() => void sessions.fetchNextPage()}
              >
                {sessions.isFetchingNextPage ? "加载中…" : "更多"}
              </button>
            )}
          </div>
        ) : (
          <p className="muted">无历史会话。</p>
        )}
      </section>

      <section className="command-preview">
        <button
          className="preview-toggle"
          onClick={() => setShowPreview((value) => !value)}
        >
          {showPreview ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          命令预览
        </button>
        {showPreview && (
          <div className="preview-body">
            <code>
              {preview.isError
                ? String(preview.error)
                : (preview.data ?? "生成中…")}
            </code>
            <button
              className="ghost-button"
              disabled={!preview.data}
              onClick={() => preview.data && void copyText(preview.data)}
            >
              <Copy size={14} />
              复制
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

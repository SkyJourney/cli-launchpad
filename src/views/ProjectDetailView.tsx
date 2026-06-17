import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Copy,
  FolderOpen,
  Pencil,
  Play,
  RefreshCw,
  RotateCcw,
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
  listSessions,
  openProjectDirectory,
  previewLaunch,
  resumeSession,
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

  const directoryId = directory?.id ?? null;
  const launchable = statusByTool[activeTool]?.status === "available";

  const sessions = useQuery({
    queryKey: qk.sessions(directoryId, activeTool),
    queryFn: () => listSessions(directoryId as number, activeTool),
    enabled: directoryId != null,
  });

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

  const supportsHistory = activeTool !== "antigravity";
  const runLaunch = () => {
    setLaunchError(null);
    launchMutation.mutate();
  };
  const runResume = (sessionId: string) => {
    setLaunchError(null);
    resumeMutation.mutate(sessionId);
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
              onClick={() => setManualTool(tool.key)}
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
          {supportsHistory && (
            <button
              className="icon-button"
              title="刷新会话"
              disabled={sessions.isFetching}
              onClick={() =>
                void queryClient.fetchQuery({
                  queryKey: qk.sessions(directoryId, activeTool),
                  queryFn: () =>
                    listSessions(directoryId as number, activeTool),
                })
              }
            >
              <RefreshCw
                size={14}
                className={sessions.isFetching ? "spinning" : undefined}
              />
            </button>
          )}
        </div>
        {!supportsHistory ? (
          <p className="muted">
            Antigravity 暂不支持历史列表，可直接启动新会话。
          </p>
        ) : sessions.isError ? (
          <p className="error">读取会话失败：{String(sessions.error)}</p>
        ) : sessions.isLoading ? (
          <p className="muted">读取中…</p>
        ) : sessions.data && sessions.data.length > 0 ? (
          <ul className="session-list">
            {sessions.data.map((session) => (
              <li className="session-row" key={session.sessionId}>
                <div className="session-meta">
                  <span className="session-title">{session.title}</span>
                  <span className="muted">
                    {formatRelativeMs(session.lastActiveMs)}
                  </span>
                </div>
                <button
                  className="ghost-button"
                  disabled={!launchable || anyPending}
                  onClick={() => runResume(session.sessionId)}
                >
                  <RotateCcw size={14} />
                  恢复
                </button>
              </li>
            ))}
          </ul>
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

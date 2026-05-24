import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Copy,
  Pencil,
  Play,
  RotateCcw,
} from "lucide-react";
import clsx from "clsx";
import { useEffect, useState } from "react";
import { indexByTool, useCliStatus } from "../hooks/useCliStatus";
import { copyText } from "../lib/clipboard";
import { formatRelativeMs } from "../lib/format";
import { TOOLS } from "../lib/tools";
import {
  launchTool,
  listDirectories,
  listSessions,
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

  const { data: directories } = useQuery({
    queryKey: ["directories"],
    queryFn: listDirectories,
  });
  const directory =
    directories?.find((d) => d.id === selectedDirectoryId) ?? null;

  const cliData = useCliStatus().data;
  const statusByTool = indexByTool(cliData);
  const [activeTool, setActiveTool] = useState<ToolKey>("claude");
  const [showPreview, setShowPreview] = useState(false);

  // When CLI status loads, if the active tab is unavailable, switch to the
  // first available tool so the user does not land on a disabled tab.
  useEffect(() => {
    if (statusByTool[activeTool]?.status === "missing") {
      const firstAvailable = TOOLS.find(
        (tool) =>
          statusByTool[tool.key] &&
          statusByTool[tool.key]!.status !== "missing",
      );
      if (firstAvailable) {
        setActiveTool(firstAvailable.key);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cliData]);

  const directoryId = directory?.id ?? null;
  const activeStatus = statusByTool[activeTool]?.status ?? "missing";
  const launchable = activeStatus === "available";

  const sessions = useQuery({
    queryKey: ["sessions", directoryId, activeTool],
    queryFn: () => listSessions(directoryId as number, activeTool),
    enabled: directoryId != null,
  });

  const preview = useQuery({
    queryKey: ["preview", directoryId, activeTool],
    queryFn: () => previewLaunch(directoryId as number, activeTool),
    enabled: directoryId != null && showPreview,
  });

  const launchMutation = useMutation({
    mutationFn: () => launchTool(directoryId as number, activeTool),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["directories"] }),
  });

  const resumeMutation = useMutation({
    mutationFn: (sessionId: string) =>
      resumeSession(directoryId as number, activeTool, sessionId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["directories"] }),
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
      </header>

      <div className="tab-row">
        {TOOLS.map((tool) => {
          const status = statusByTool[tool.key]?.status ?? "missing";
          const disabled = status === "missing";
          return (
            <button
              key={tool.key}
              className={clsx("tab", { active: tool.key === activeTool })}
              disabled={disabled}
              onClick={() => setActiveTool(tool.key)}
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
          onClick={() => launchMutation.mutate()}
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

      <section>
        <div className="section-heading">历史会话</div>
        {!supportsHistory ? (
          <p className="muted">
            Antigravity 暂不支持历史列表，可直接启动新会话。
          </p>
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
                  onClick={() => resumeMutation.mutate(session.sessionId)}
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
            <code>{preview.data ?? "生成中…"}</code>
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

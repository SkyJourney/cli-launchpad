import { Check, FolderOpen, Pencil, Pin, Trash2, X } from "lucide-react";
import clsx from "clsx";
import { useEffect, useState } from "react";
import { CLI_STATUS_META, type CliStatusByTool } from "../hooks/useCliStatus";
import { formatRelative } from "../lib/format";
import { TOOLS } from "../lib/tools";
import type { Directory, ToolKey } from "../lib/tauri";

interface ProjectCardProps {
  directory: Directory;
  statusByTool: CliStatusByTool;
  onOpen: (id: number) => void;
  onLaunch: (id: number, toolKey: ToolKey) => void;
  onOpenPath: (id: number) => void;
  onTogglePin: (directory: Directory) => void;
  onEdit: (id: number) => void;
  onRemove: (directory: Directory) => void;
}

export function ProjectCard({
  directory,
  statusByTool,
  onOpen,
  onLaunch,
  onOpenPath,
  onTogglePin,
  onEdit,
  onRemove,
}: ProjectCardProps) {
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  // Auto-cancel the pending removal if the user does not confirm quickly.
  useEffect(() => {
    if (!confirmingRemove) {
      return;
    }
    const timer = window.setTimeout(() => setConfirmingRemove(false), 4000);
    return () => window.clearTimeout(timer);
  }, [confirmingRemove]);

  return (
    <div
      className="project-card"
      role="button"
      tabIndex={0}
      aria-label={`打开 ${directory.name}`}
      onClick={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest("button, .project-card-actions, .badge-row")
        ) {
          return;
        }
        onOpen(directory.id);
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) {
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen(directory.id);
        }
      }}
    >
      <div className="project-card-main">
        <div className="project-card-head">
          <strong>
            {directory.pinned && <span className="pin-mark">★</span>}
            {directory.name}
          </strong>
          <span className="muted">{formatRelative(directory.lastUsedAt)}</span>
        </div>
        <span className="project-card-path">{directory.path}</span>
      </div>

      <div className="badge-row">
        {TOOLS.map((tool) => {
          const status = statusByTool[tool.key]?.status ?? "missing";
          const meta = CLI_STATUS_META[status];
          const launchable = status === "available";
          return (
            <button
              key={tool.key}
              className={clsx("cli-badge", meta.badgeClass)}
              title={`${tool.label} · ${meta.title}`}
              disabled={!launchable}
              onClick={(event) => {
                event.stopPropagation();
                onLaunch(directory.id, tool.key);
              }}
            >
              <tool.icon size={16} />
            </button>
          );
        })}
      </div>

      <div className="project-card-actions">
        <button
          className={clsx("icon-button", { active: directory.pinned })}
          title={directory.pinned ? "取消置顶" : "置顶"}
          onClick={(event) => {
            event.stopPropagation();
            onTogglePin(directory);
          }}
        >
          <Pin size={15} />
        </button>
        <button
          className="icon-button"
          title="打开项目目录"
          onClick={(event) => {
            event.stopPropagation();
            onOpenPath(directory.id);
          }}
        >
          <FolderOpen size={15} />
        </button>
        <button
          className="icon-button"
          title="编辑参数"
          onClick={(event) => {
            event.stopPropagation();
            onEdit(directory.id);
          }}
        >
          <Pencil size={15} />
        </button>
        {confirmingRemove ? (
          <div className="confirm-remove">
            <span className="muted">确认移除？</span>
            <button
              className="icon-button danger"
              title="确认移除（仅删除启动配置，不影响磁盘文件）"
              onClick={(event) => {
                event.stopPropagation();
                setConfirmingRemove(false);
                onRemove(directory);
              }}
            >
              <Check size={15} />
            </button>
            <button
              className="icon-button"
              title="取消"
              onClick={(event) => {
                event.stopPropagation();
                setConfirmingRemove(false);
              }}
            >
              <X size={15} />
            </button>
          </div>
        ) : (
          <button
            className="icon-button danger"
            title="移除目录"
            onClick={(event) => {
              event.stopPropagation();
              setConfirmingRemove(true);
            }}
          >
            <Trash2 size={15} />
          </button>
        )}
      </div>
    </div>
  );
}

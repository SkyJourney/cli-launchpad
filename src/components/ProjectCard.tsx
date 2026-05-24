import { Check, Pencil, Pin, Trash2, X } from "lucide-react";
import clsx from "clsx";
import { useEffect, useState } from "react";
import type { CliStatusByTool } from "../hooks/useCliStatus";
import { formatRelative } from "../lib/format";
import { TOOLS } from "../lib/tools";
import type { CliAvailability, Directory, ToolKey } from "../lib/tauri";

const STATUS_CLASS: Record<CliAvailability, string> = {
  available: "badge-available",
  path_not_visible: "badge-warn",
  missing: "badge-missing",
};

const STATUS_TITLE: Record<CliAvailability, string> = {
  available: "已安装，可直接启动",
  path_not_visible: "已安装但 PATH 不可见",
  missing: "未检测到，前往设置安装",
};

interface ProjectCardProps {
  directory: Directory;
  statusByTool: CliStatusByTool;
  onOpen: (id: number) => void;
  onLaunch: (id: number, toolKey: ToolKey) => void;
  onTogglePin: (directory: Directory) => void;
  onEdit: (id: number) => void;
  onRemove: (directory: Directory) => void;
}

export function ProjectCard({
  directory,
  statusByTool,
  onOpen,
  onLaunch,
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
    <div className="project-card">
      <button
        className="project-card-main"
        onClick={() => onOpen(directory.id)}
      >
        <div className="project-card-head">
          <strong>
            {directory.pinned && <span className="pin-mark">★</span>}
            {directory.name}
          </strong>
          <span className="muted">{formatRelative(directory.lastUsedAt)}</span>
        </div>
        <span className="project-card-path">{directory.path}</span>
      </button>

      <div className="badge-row">
        {TOOLS.map((tool) => {
          const status = statusByTool[tool.key]?.status ?? "missing";
          const launchable = status === "available";
          return (
            <button
              key={tool.key}
              className={clsx("cli-badge", STATUS_CLASS[status])}
              title={`${tool.label} · ${STATUS_TITLE[status]}`}
              disabled={!launchable}
              onClick={() => onLaunch(directory.id, tool.key)}
            >
              <tool.icon size={14} />
              <span>{tool.shortLabel}</span>
            </button>
          );
        })}
      </div>

      <div className="project-card-actions">
        <button
          className={clsx("icon-button", { active: directory.pinned })}
          title={directory.pinned ? "取消置顶" : "置顶"}
          onClick={() => onTogglePin(directory)}
        >
          <Pin size={15} />
        </button>
        <button
          className="icon-button"
          title="编辑参数"
          onClick={() => onEdit(directory.id)}
        >
          <Pencil size={15} />
        </button>
        {confirmingRemove ? (
          <div className="confirm-remove">
            <span className="muted">确认移除？</span>
            <button
              className="icon-button danger"
              title="确认移除（仅删除启动配置，不影响磁盘文件）"
              onClick={() => {
                setConfirmingRemove(false);
                onRemove(directory);
              }}
            >
              <Check size={15} />
            </button>
            <button
              className="icon-button"
              title="取消"
              onClick={() => setConfirmingRemove(false)}
            >
              <X size={15} />
            </button>
          </div>
        ) : (
          <button
            className="icon-button danger"
            title="移除目录"
            onClick={() => setConfirmingRemove(true)}
          >
            <Trash2 size={15} />
          </button>
        )}
      </div>
    </div>
  );
}

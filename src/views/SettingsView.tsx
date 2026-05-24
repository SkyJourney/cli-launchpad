import { ArrowLeft, RefreshCw } from "lucide-react";
import clsx from "clsx";
import { indexByTool, useCliStatus } from "../hooks/useCliStatus";
import { TOOLS } from "../lib/tools";
import type { CliAvailability } from "../lib/tauri";
import { useAppStore } from "../store/appStore";

const STATUS_LABEL: Record<CliAvailability, string> = {
  available: "已安装 · PATH 可见",
  path_not_visible: "已安装 · PATH 不可见",
  missing: "未检测到",
};

const STATUS_CLASS: Record<CliAvailability, string> = {
  available: "badge-available",
  path_not_visible: "badge-warn",
  missing: "badge-missing",
};

export function SettingsView() {
  const setView = useAppStore((state) => state.setView);
  const cliStatus = useCliStatus();
  const statusByTool = indexByTool(cliStatus.data);

  return (
    <div className="settings-view">
      <button className="ghost-button" onClick={() => setView("projects")}>
        <ArrowLeft size={15} />
        返回
      </button>

      <header className="detail-head settings-head">
        <h1>设置</h1>
        <button
          className="icon-button"
          title="重新检测"
          onClick={() => cliStatus.refetch()}
          disabled={cliStatus.isFetching}
        >
          <RefreshCw
            size={15}
            className={clsx({ spinning: cliStatus.isFetching })}
          />
        </button>
      </header>

      <section className="cli-status-list">
        <div className="section-heading">CLI 状态</div>
        {TOOLS.map((tool) => {
          const status = statusByTool[tool.key];
          const availability = status?.status ?? "missing";
          return (
            <div className="cli-status-row" key={tool.key}>
              <div className="cli-status-name">
                <tool.icon size={18} />
                <strong>{tool.label}</strong>
                <span className={clsx("cli-badge", STATUS_CLASS[availability])}>
                  {STATUS_LABEL[availability]}
                </span>
              </div>
              <div className="cli-status-detail muted">
                {status?.path && <span>路径：{status.path}</span>}
                {status?.version && <span>当前：{status.version}</span>}
                {!status?.version && availability !== "missing" && (
                  <span>当前：未知</span>
                )}
              </div>
            </div>
          );
        })}
        <p className="muted">
          最新版本对比与应用内更新/安装将在里程碑 5 实现。
        </p>
      </section>
    </div>
  );
}

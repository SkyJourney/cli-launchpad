import { FolderKanban, Info, Settings, SquareTerminal } from "lucide-react";
import clsx from "clsx";
import GithubMono from "@lobehub/icons/es/Github/components/Mono";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  isExecutionActive,
  useExecutionTasks,
} from "../hooks/useExecutionTasks";
import { useAppStore } from "../store/appStore";
import { AppLogo } from "./AppLogo";

const REPOSITORY_URL = "https://github.com/SkyJourney/cli-launchpad";

export function Sidebar() {
  const view = useAppStore((state) => state.view);
  const setView = useAppStore((state) => state.setView);
  const tasks = useExecutionTasks();
  const activeCount =
    tasks.data?.filter((task) => isExecutionActive(task.status)).length ?? 0;

  const onProjects =
    view === "projects" || view === "detail" || view === "edit";

  return (
    <aside className="sidebar">
      <div className="brand">
        <AppLogo size={32} />
        <span>CLI Launchpad</span>
      </div>

      <nav className="sidebar-nav">
        <button
          className={clsx("nav-item", { active: onProjects })}
          onClick={() => setView("projects")}
        >
          <FolderKanban size={16} />
          项目
        </button>
        <button
          className={clsx("nav-item", { active: view === "executions" })}
          onClick={() => setView("executions")}
        >
          <SquareTerminal size={16} />
          <span>执行任务</span>
          {activeCount > 0 && (
            <span
              className="nav-count"
              aria-label={`${activeCount} 个执行中任务`}
            >
              {activeCount}
            </span>
          )}
        </button>
        <button
          className={clsx("nav-item", { active: view === "settings" })}
          onClick={() => setView("settings")}
        >
          <Settings size={16} />
          设置
        </button>
        <button
          className={clsx("nav-item", { active: view === "about" })}
          onClick={() => setView("about")}
        >
          <Info size={16} />
          关于
        </button>
      </nav>

      <div className="sidebar-footer">
        <button
          type="button"
          className="icon-button sidebar-repository-button"
          title="打开 GitHub 项目仓库"
          aria-label="打开 GitHub 项目仓库"
          onClick={() => {
            void openUrl(REPOSITORY_URL).catch((error: unknown) => {
              console.error("无法打开 GitHub 项目仓库", error);
              window.alert("无法使用系统默认浏览器打开 GitHub 项目仓库。");
            });
          }}
        >
          <GithubMono size={20} />
        </button>
      </div>
    </aside>
  );
}

import {
  FolderKanban,
  Info,
  Settings,
  SquareTerminal,
  Terminal,
} from "lucide-react";
import clsx from "clsx";
import {
  isExecutionActive,
  useExecutionTasks,
} from "../hooks/useExecutionTasks";
import { useAppStore } from "../store/appStore";

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
        <Terminal size={20} />
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
    </aside>
  );
}

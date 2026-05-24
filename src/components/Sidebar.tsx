import { FolderKanban, Settings, Terminal } from "lucide-react";
import clsx from "clsx";
import { useAppStore } from "../store/appStore";

export function Sidebar() {
  const view = useAppStore((state) => state.view);
  const setView = useAppStore((state) => state.setView);

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
          className={clsx("nav-item", { active: view === "settings" })}
          onClick={() => setView("settings")}
        >
          <Settings size={16} />
          设置
        </button>
      </nav>
    </aside>
  );
}

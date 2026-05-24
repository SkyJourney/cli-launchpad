import { ArrowLeft } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { listDirectories } from "../lib/tauri";
import { useAppStore } from "../store/appStore";

export function ProjectDetailView() {
  const selectedDirectoryId = useAppStore((state) => state.selectedDirectoryId);
  const setView = useAppStore((state) => state.setView);
  const { data: directories } = useQuery({
    queryKey: ["directories"],
    queryFn: listDirectories,
  });
  const directory =
    directories?.find((d) => d.id === selectedDirectoryId) ?? null;

  return (
    <div className="detail-view">
      <button className="ghost-button" onClick={() => setView("projects")}>
        <ArrowLeft size={15} />
        返回
      </button>
      {directory ? (
        <header className="detail-head">
          <h1>{directory.name}</h1>
          <p className="muted">{directory.path}</p>
        </header>
      ) : (
        <p className="muted">未选择目录。</p>
      )}
      <p className="muted">会话历史 Tab 与一键启动将在里程碑 3 实现。</p>
    </div>
  );
}

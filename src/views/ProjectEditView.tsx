import { ArrowLeft } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { listDirectories } from "../lib/tauri";
import { useAppStore } from "../store/appStore";

export function ProjectEditView() {
  const selectedDirectoryId = useAppStore((state) => state.selectedDirectoryId);
  const setView = useAppStore((state) => state.setView);
  const { data: directories } = useQuery({
    queryKey: ["directories"],
    queryFn: listDirectories,
  });
  const directory =
    directories?.find((d) => d.id === selectedDirectoryId) ?? null;

  return (
    <div className="edit-view">
      <button className="ghost-button" onClick={() => setView("projects")}>
        <ArrowLeft size={15} />
        返回
      </button>
      <header className="detail-head">
        <h1>编辑参数{directory ? ` · ${directory.name}` : ""}</h1>
      </header>
      <p className="muted">按 CLI 分区的参数编辑将在里程碑 4 实现。</p>
    </div>
  );
}

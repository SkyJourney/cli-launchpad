import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, RefreshCw, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { ProjectCard } from "../components/ProjectCard";
import { indexByTool, useCliStatus } from "../hooks/useCliStatus";
import {
  addDirectory,
  launchTool,
  listDirectories,
  removeDirectory,
  setDirectoryPinned,
  type Directory,
  type ToolKey,
} from "../lib/tauri";
import { useAppStore } from "../store/appStore";

type SortMode = "recent" | "name";

export function ProjectsView() {
  const queryClient = useQueryClient();
  const openDirectory = useAppStore((state) => state.openDirectory);
  const setView = useAppStore((state) => state.setView);
  const selectDirectory = useAppStore((state) => state.selectDirectory);

  const { data: directories } = useQuery({
    queryKey: ["directories"],
    queryFn: listDirectories,
  });
  const cliStatus = useCliStatus();
  const statusByTool = indexByTool(cliStatus.data);

  const [search, setSearch] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("recent");
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPath, setNewPath] = useState("");

  const invalidateDirectories = () =>
    queryClient.invalidateQueries({ queryKey: ["directories"] });

  const addMutation = useMutation({
    mutationFn: () => addDirectory(newName.trim(), newPath.trim()),
    onSuccess: () => {
      setNewName("");
      setNewPath("");
      setShowAdd(false);
      invalidateDirectories();
    },
  });

  const pinMutation = useMutation({
    mutationFn: (directory: Directory) =>
      setDirectoryPinned(directory.id, !directory.pinned),
    onSuccess: invalidateDirectories,
  });

  const removeMutation = useMutation({
    mutationFn: (id: number) => removeDirectory(id),
    onSuccess: invalidateDirectories,
  });

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    const filtered = (directories ?? []).filter(
      (d) =>
        !term ||
        d.name.toLowerCase().includes(term) ||
        d.path.toLowerCase().includes(term),
    );
    const sorted = [...filtered].sort((a, b) => {
      if (a.pinned !== b.pinned) {
        return a.pinned ? -1 : 1;
      }
      if (sortMode === "name") {
        return a.name.localeCompare(b.name);
      }
      return (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? "");
    });
    return sorted;
  }, [directories, search, sortMode]);

  const handleLaunch = (id: number, toolKey: ToolKey) => {
    void launchTool(id, toolKey);
  };

  const handleEdit = (id: number) => {
    selectDirectory(id);
    setView("edit");
  };

  const handleRemove = (directory: Directory) => {
    removeMutation.mutate(directory.id);
  };

  const canSubmit = newName.trim().length > 0 && newPath.trim().length > 0;

  return (
    <div className="projects-view">
      <header className="projects-toolbar">
        <h1>项目</h1>
        <div className="toolbar-controls">
          <label className="search-box">
            <Search size={15} />
            <input
              placeholder="搜索名称或路径"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <select
            value={sortMode}
            onChange={(event) => setSortMode(event.target.value as SortMode)}
          >
            <option value="recent">最近使用</option>
            <option value="name">名称</option>
          </select>
          <button
            className="icon-button"
            title="重新检测 CLI"
            onClick={() => void cliStatus.refetch()}
            disabled={cliStatus.isFetching}
          >
            <RefreshCw
              size={15}
              className={cliStatus.isFetching ? "spinning" : undefined}
            />
          </button>
          <button
            className="primary-button"
            onClick={() => setShowAdd((value) => !value)}
          >
            <Plus size={15} />
            添加目录
          </button>
        </div>
      </header>

      {showAdd && (
        <div className="add-form">
          <input
            placeholder="名称"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
          />
          <input
            placeholder="完整路径，例如 C:\\Projects\\my-app"
            value={newPath}
            onChange={(event) => setNewPath(event.target.value)}
          />
          <button
            className="primary-button"
            disabled={!canSubmit || addMutation.isPending}
            onClick={() => addMutation.mutate()}
          >
            保存
          </button>
          <button className="ghost-button" onClick={() => setShowAdd(false)}>
            取消
          </button>
        </div>
      )}
      {addMutation.isError && (
        <p className="error">添加失败：{String(addMutation.error)}</p>
      )}

      {visible.length === 0 ? (
        <p className="muted">没有匹配的目录。点击「添加目录」创建第一个。</p>
      ) : (
        <div className="project-grid">
          {visible.map((directory) => (
            <ProjectCard
              key={directory.id}
              directory={directory}
              statusByTool={statusByTool}
              onOpen={openDirectory}
              onLaunch={handleLaunch}
              onTogglePin={(d) => pinMutation.mutate(d)}
              onEdit={handleEdit}
              onRemove={handleRemove}
            />
          ))}
        </div>
      )}
    </div>
  );
}

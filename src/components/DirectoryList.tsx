import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { listDirectories } from "../lib/tauri";
import { useAppStore } from "../store/appStore";

export function DirectoryList() {
  const selectedDirectoryId = useAppStore((state) => state.selectedDirectoryId);
  const selectDirectory = useAppStore((state) => state.selectDirectory);

  const {
    data: directories,
    isLoading,
    isError,
    error,
  } = useQuery({ queryKey: ["directories"], queryFn: listDirectories });

  return (
    <div className="directory-list">
      <div className="section-heading">Directories</div>

      {isLoading && <p className="muted">加载中…</p>}
      {isError && <p className="error">加载失败：{String(error)}</p>}
      {!isLoading && !isError && directories?.length === 0 && (
        <p className="muted">尚无目录</p>
      )}

      {directories?.map((directory) => (
        <button
          className={clsx("directory-item", {
            active: directory.id === selectedDirectoryId,
          })}
          key={directory.id}
          onClick={() => selectDirectory(directory.id)}
        >
          <strong>{directory.name}</strong>
          <span>{directory.path}</span>
        </button>
      ))}
    </div>
  );
}

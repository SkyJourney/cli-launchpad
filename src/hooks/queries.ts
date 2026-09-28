import { useQuery } from "@tanstack/react-query";
import { qk } from "../lib/queryKeys";
import { listDirectories, type Directory } from "../lib/tauri";

export function useDirectories() {
  return useQuery({ queryKey: qk.directories(), queryFn: listDirectories });
}

/// Resolve the selected directory entity from the cached directory list.
export function useDirectory(id: number | null): Directory | null {
  const { data } = useDirectories();
  return data?.find((directory) => directory.id === id) ?? null;
}

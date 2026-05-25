import { useQuery } from "@tanstack/react-query";
import { qk } from "../lib/queryKeys";
import { listDirectories, listTools, type Directory } from "../lib/tauri";

export function useDirectories() {
  return useQuery({ queryKey: qk.directories(), queryFn: listDirectories });
}

export function useTools() {
  return useQuery({ queryKey: qk.tools(), queryFn: listTools });
}

/// Resolve the selected directory entity from the cached directory list.
export function useDirectory(id: number | null): Directory | null {
  const { data } = useDirectories();
  return data?.find((directory) => directory.id === id) ?? null;
}

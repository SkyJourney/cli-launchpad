import { useQuery } from "@tanstack/react-query";
import { detectCliStatus, type CliStatus, type ToolKey } from "../lib/tauri";

export function useCliStatus() {
  return useQuery({
    queryKey: ["cli-status"],
    queryFn: detectCliStatus,
    staleTime: Infinity,
  });
}

export type CliStatusByTool = Record<ToolKey, CliStatus | undefined>;

export function indexByTool(
  statuses: CliStatus[] | undefined,
): CliStatusByTool {
  const map = {} as CliStatusByTool;
  for (const status of statuses ?? []) {
    map[status.toolKey] = status;
  }
  return map;
}

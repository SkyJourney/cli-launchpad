import { useQuery } from "@tanstack/react-query";
import { qk } from "../lib/queryKeys";
import {
  detectCliStatus,
  type CliAvailability,
  type CliStatus,
  type ToolKey,
} from "../lib/tauri";

export function useCliStatus() {
  return useQuery({
    queryKey: qk.cliStatus(),
    queryFn: detectCliStatus,
    // CLI detection runs subprocesses; refresh is user-driven (the settings /
    // projects "重新检测" buttons) and after install/update invalidation.
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

/// Single source for CLI availability → badge style / labels, shared by the
/// project cards and the settings panel.
export const CLI_STATUS_META: Record<
  CliAvailability,
  { badgeClass: string; label: string; title: string }
> = {
  available: {
    badgeClass: "badge-available",
    label: "已安装",
    title: "已安装，可直接启动",
  },
  missing: {
    badgeClass: "badge-missing",
    label: "未检测到",
    title: "未检测到，前往设置安装",
  },
};

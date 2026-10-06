import { useQueries, type QueryClient } from "@tanstack/react-query";
import { qk } from "../lib/queryKeys";
import { TOOLS } from "../lib/tools";
import {
  detectCliStatus,
  type CliAvailability,
  type CliStatus,
  type ToolKey,
} from "../lib/tauri";

export function useCliStatus(probeVersions = false) {
  const queries = useQueries({
    queries: TOOLS.map((tool) => ({
      queryKey: qk.cliStatus(tool.key),
      queryFn: () => detectOneCliStatus(tool.key, probeVersions),
      // Detection is refreshed by user action or after this CLI's own task.
      staleTime: Infinity,
      refetchOnMount: probeVersions ? ("always" as const) : undefined,
    })),
  });

  return {
    data: queries.flatMap((query) => (query.data ? [query.data] : [])),
    isLoading: queries.some((query) => query.isLoading),
    isFetching: queries.some((query) => query.isFetching),
    isError: queries.some((query) => query.isError),
    error: queries.find((query) => query.error)?.error ?? null,
  };
}

export function refreshCliStatusForTool(
  queryClient: Pick<QueryClient, "fetchQuery">,
  toolKey: ToolKey,
  detect: typeof detectCliStatus = detectCliStatus,
) {
  return queryClient.fetchQuery({
    queryKey: qk.cliStatus(toolKey),
    queryFn: () => detectOneCliStatus(toolKey, true, detect),
  });
}

async function detectOneCliStatus(
  toolKey: ToolKey,
  force: boolean,
  detect = detectCliStatus,
) {
  const statuses = await detect(toolKey, force);
  const status = statuses[0];
  if (!status) throw new Error(`检测 ${toolKey} 状态时未返回结果`);
  return status;
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

/// Single source for CLI availability → badge style / translation keys, shared by the
/// project cards and the settings panel.
export const CLI_STATUS_META: Record<
  CliAvailability,
  {
    badgeClass: string;
    labelKey: "cliStatus.available" | "cliStatus.missing" | "cliStatus.unknown";
    titleKey:
      | "cliStatus.availableTitle"
      | "cliStatus.missingTitle"
      | "cliStatus.unknownTitle";
  }
> = {
  available: {
    badgeClass: "badge-available",
    labelKey: "cliStatus.available",
    titleKey: "cliStatus.availableTitle",
  },
  missing: {
    badgeClass: "badge-missing",
    labelKey: "cliStatus.missing",
    titleKey: "cliStatus.missingTitle",
  },
  unknown: {
    badgeClass: "badge-missing",
    labelKey: "cliStatus.unknown",
    titleKey: "cliStatus.unknownTitle",
  },
};

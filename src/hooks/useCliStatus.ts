import { useQuery } from "@tanstack/react-query";
import { qk } from "../lib/queryKeys";
import {
  detectCliStatus,
  type CliAvailability,
  type CliStatus,
  type ToolKey,
} from "../lib/tauri";

export function useCliStatus(probeVersions = false) {
  return useQuery({
    queryKey: qk.cliStatus(),
    queryFn: () => detectCliStatus(probeVersions),
    // CLI detection runs subprocesses; refresh is user-driven (the settings /
    // projects refresh buttons) and after install/update invalidation. Settings
    // opts into a forced version probe every time the view is mounted.
    staleTime: Infinity,
    refetchOnMount: probeVersions ? "always" : undefined,
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

/// Single source for CLI availability → badge style / translation keys, shared by the
/// project cards and the settings panel.
export const CLI_STATUS_META: Record<
  CliAvailability,
  {
    badgeClass: string;
    labelKey:
      | "cliStatus.available"
      | "cliStatus.missing"
      | "cliStatus.unknown";
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

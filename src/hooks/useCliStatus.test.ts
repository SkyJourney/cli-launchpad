import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { qk } from "../lib/queryKeys";
import type { CliStatus, ToolKey } from "../lib/tauri";
import { refreshCliStatusForTool } from "./useCliStatus";

function status(toolKey: ToolKey): CliStatus {
  return {
    toolKey,
    status: "available",
    path: `/tools/${toolKey}`,
    resolvedCommand: toolKey,
    version: null,
    versionError: null,
    latestVersion: null,
  };
}

describe("refreshCliStatusForTool", () => {
  it("refreshes and caches only the CLI whose task completed", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const detect = vi.fn(async (toolKey?: ToolKey) => [
      status(toolKey ?? "codex"),
    ]);

    await refreshCliStatusForTool(queryClient, "codex", detect);

    expect(detect).toHaveBeenCalledTimes(1);
    expect(detect).toHaveBeenCalledWith("codex", true);
    expect(queryClient.getQueryData(qk.cliStatus("codex"))).toEqual(
      status("codex"),
    );
    expect(queryClient.getQueryData(qk.cliStatus("claude"))).toBeUndefined();
  });
});

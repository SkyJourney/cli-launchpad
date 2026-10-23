import { toast } from "sonner";
import { getAppErrorMessage } from "./appErrors";
import { reportWindowSyncFailureToBackend } from "./tauri";

/**
 * Reports a native window synchronisation failure. The failure is always
 * logged to the console and sent to the application diagnostics log through the
 * backend (report_window_sync_failure). Development builds additionally surface
 * it as a toast so that configuration defects cannot go unnoticed. A failing
 * backend call is swallowed: the reporting channel may be the thing that broke.
 */
export function reportWindowSyncFailure(
  code: string,
  error: unknown,
  description = "原生窗口偏好同步失败",
): void {
  console.warn(`[${code}] ${description}`, error);
  const detail = describeError(error);
  try {
    void reportWindowSyncFailureToBackend(
      code,
      `${description}: ${detail}`,
    ).catch(() => undefined);
  } catch {
    // The reporting channel itself failed; the console and toast here still apply.
  }
  if (import.meta.env.DEV) {
    toast.error(`${code}: ${detail}`);
  }
}

/** Describing the failure must never hide it: fall back to a fixed text. */
function describeError(error: unknown): string {
  try {
    return getAppErrorMessage(error);
  } catch {
    return "unknown error";
  }
}

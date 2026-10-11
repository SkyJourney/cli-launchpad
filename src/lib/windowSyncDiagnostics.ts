import { toast } from "sonner";
import { getAppErrorMessage } from "./appErrors";

/**
 * Reports a native window synchronisation failure. The failure is always
 * logged to the console; development builds additionally surface it as a
 * toast so that configuration defects (for example a missing permission)
 * cannot go unnoticed. Production builds do not persist the failure anywhere
 * else. Writing failures to the application diagnostics log would need a new
 * command or dependency, which has not been decided.
 */
export function reportWindowSyncFailure(
  code: string,
  error: unknown,
  description = "原生窗口偏好同步失败",
): void {
  console.warn(`[${code}] ${description}`, error);
  if (import.meta.env.DEV) {
    toast.error(`${code}: ${getAppErrorMessage(error)}`);
  }
}

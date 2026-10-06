import type { TFunction } from "i18next";

type AppErrorParams = Record<string, string | number | boolean>;

const errorTranslationKeys: Record<string, string> = {
  "file.not_found": "errors.fileNotFound",
  "file.too_large": "errors.fileTooLarge",
  "file.conflict": "errors.fileConflict",
  "file.identity_changed": "errors.fileIdentityChanged",
  project_identity_changed: "errors.fileIdentityChanged",
  "pty.owner_mismatch": "errors.ptyOwnerMismatch",
  "pty.handoff_expired": "errors.ptyHandoffExpired",
  pty_input_backpressure: "errors.ptyInputBackpressure",
  "pty.input_backpressure": "errors.ptyInputBackpressure",
  pty_input_unavailable: "errors.ptyInputUnavailable",
  pty_sessions_active: "errors.ptySessionsActive",
  backup_restore_in_progress: "errors.backupRestoreInProgress",
  pty_session_starting: "errors.ptySessionStarting",
  "exec.plan_changed": "errors.execPlanChanged",
  plan_changed: "errors.execPlanChanged",
  "exec.busy": "errors.execBusy",
  "layout.needs_reset": "errors.layoutNeedsReset",
  "directory.in_use": "errors.directoryInUse",
};

export function getAppErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

export function getAppErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error);
}

export function formatAppError(error: unknown, t: TFunction): string {
  const code = getAppErrorCode(error);
  const key = code ? errorTranslationKeys[code] : undefined;
  if (!key) return getAppErrorMessage(error);

  const fallback = getAppErrorMessage(error);
  const params = getAppErrorParams(error);
  return String(
    t(key as never, { ...params, defaultValue: fallback } as never),
  );
}

function getAppErrorParams(error: unknown): AppErrorParams {
  if (
    typeof error !== "object" ||
    error === null ||
    !("params" in error) ||
    typeof error.params !== "object" ||
    error.params === null ||
    Array.isArray(error.params)
  ) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(error.params).filter(
      ([, value]) =>
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean",
    ),
  );
}

export function isProjectIdentityChangedError(error: unknown): boolean {
  const code = getAppErrorCode(error);
  return (
    code === "project_identity_changed" || code === "file.identity_changed"
  );
}

import type { TFunction } from "i18next";
import errorCodes from "../../contracts/error-codes.json";

type AppErrorParams = Record<string, string | number | boolean>;

const TRANSLATION_KEYS_BY_CODE: Readonly<Record<string, string>> = {
  "app.data_replace_blocked": "errors.dataReplaceBlocked",
  "app.data_replace_in_progress": "errors.dataReplaceInProgress",
  "app.error": "errors.appError",
  "app.exit_deferred": "errors.appExitDeferred",
  "app.exiting": "errors.appExiting",
  "backup.restore_in_progress": "errors.backupRestoreInProgress",
  "blocking.timeout": "errors.internal",
  "config.import_in_progress": "errors.configImportInProgress",
  "db.poisoned": "errors.internal",
  "directory.in_use": "errors.directoryInUse",
  "exec.plan_changed": "errors.execPlanChanged",
  "exit.no_pending_request": "errors.exitNoPendingRequest",
  "exit.request_mismatch": "errors.exitRequestMismatch",
  "internal.task_failed": "errors.internal",
  "project.identity_changed": "errors.fileIdentityChanged",
  "project.not_found": "errors.projectNotFound",
  "pty.handoff_target_is_source": "errors.ptyHandoffTargetIsSource",
  "pty.input_backpressure": "errors.ptyInputBackpressure",
  "pty.input_unavailable": "errors.ptyInputUnavailable",
  "pty.session_starting": "errors.ptySessionStarting",
  "pty.sessions_active": "errors.ptySessionsActive",
  "window.label_invalid": "errors.internal",
  "window.not_allowed": "errors.internal",
  "layout.needs_reset": "errors.layoutNeedsReset",
  "layout.save_rejected": "errors.layoutSaveRejected",
  "layout.schema_incompatible": "errors.layoutSchemaIncompatible",
  "file.too_large": "errors.fileTooLarge",
};

const ALIASES: Readonly<Record<string, string>> = errorCodes.aliases;

/** Translation keys for every code in contracts/error-codes.json, aliases included. */
export const APP_ERROR_TRANSLATION_KEYS: Readonly<Record<string, string>> =
  Object.freeze({
    ...TRANSLATION_KEYS_BY_CODE,
    ...Object.fromEntries(
      Object.entries(ALIASES).map(([alias, code]) => [
        alias,
        TRANSLATION_KEYS_BY_CODE[code],
      ]),
    ),
  });

/** Reads only the object's own entries, so inherited names such as `constructor` never match. */
function ownEntry(
  map: Readonly<Record<string, string>>,
  key: string,
): string | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

/** Maps a legacy alias to its current code; unknown codes are returned unchanged. */
export function normalizeAppErrorCode(
  code: string | undefined,
): string | undefined {
  return code === undefined ? undefined : (ownEntry(ALIASES, code) ?? code);
}

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
  const key = code ? ownEntry(APP_ERROR_TRANSLATION_KEYS, code) : undefined;
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
  return (
    normalizeAppErrorCode(getAppErrorCode(error)) === "project.identity_changed"
  );
}

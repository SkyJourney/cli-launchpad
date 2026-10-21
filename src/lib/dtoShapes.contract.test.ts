import { describe, expect, it } from "vitest";
import { keysOf } from "../test/dtoKeys";
import type {
  BackupManifest,
  CacheStats,
  CliStatus,
  Directory,
  ExecutionLogChunk,
  ExecutionTask,
  ExecutionTaskDetail,
  FileIdentityComparison,
  InstallPlan,
  LatestVersion,
  LaunchHistoryEntry,
  PathSemantics,
  ProjectDirectoryListing,
  ProjectFileCasResidue,
  ProjectFileCasResidueListing,
  ProjectFileEntry,
  ProjectFileOpenResult,
  ProjectTextFileSaveResult,
  PtyEvent,
  PtyHandoff,
  PtySession,
  SendWindowMessageResult,
  SessionInfo,
  SessionPage,
  SessionSearchIndexRefresh,
  SessionSearchResults,
  StartupNotice,
  WindowInboxSubscription,
  WorkspaceLayoutPresetSummary,
  WorkspaceLayoutStateRead,
  WorkspaceSlotState,
} from "./tauri";

const fixtureFiles = import.meta.glob("../../contracts/fixtures/*.json", {
  eager: true,
  import: "default",
}) as Record<
  string,
  {
    schema: number;
    type: string;
    cases: Array<{ name: string; value: unknown }>;
  }
>;

function cases(file: string) {
  const entry = fixtureFiles[`../../contracts/fixtures/${file}`];
  expect(entry, `缺少 fixture ${file}`).toBeDefined();
  expect(entry.cases.length, `${file} 没有 case`).toBeGreaterThan(0);
  return entry.cases;
}

function sortedKeys(value: unknown): string[] {
  return Object.keys(value as Record<string, unknown>).sort();
}

function expectKeys(label: string, value: unknown, keys: readonly string[]) {
  expect(sortedKeys(value), label).toEqual([...keys].sort());
}

const DIRECTORY = keysOf<Directory>()([
  "id",
  "name",
  "path",
  "sortOrder",
  "pinned",
  "note",
]);
const BACKUP = keysOf<BackupManifest>()([
  "id",
  "createdAtMs",
  "reason",
  "schemaVersion",
  "databaseFilename",
  "sizeBytes",
]);
const PRESET = keysOf<WorkspaceLayoutPresetSummary>()([
  "id",
  "name",
  "schemaVersion",
  "createdAtMs",
  "updatedAtMs",
]);
const HISTORY = keysOf<LaunchHistoryEntry>()([
  "id",
  "directoryName",
  "directoryPath",
  "toolKey",
  "action",
  "success",
  "errorCategory",
  "launchedAt",
  "ptySessionId",
]);
const CACHE = keysOf<CacheStats>()([
  "sizeBytes",
  "entryCount",
  "newestEntryAtMs",
]);
const HANDOFF = keysOf<PtyHandoff>()(["token", "sequence"]);
const SESSION = keysOf<PtySession>()([
  "sessionId",
  "directoryId",
  "toolKey",
  "workingDirectory",
  "state",
  "startedAtMs",
  "endedAtMs",
  "exitCode",
]);
const LOG_CHUNK = keysOf<ExecutionLogChunk>()([
  "taskId",
  "sequence",
  "stream",
  "content",
  "createdAtMs",
]);
const TASK = keysOf<ExecutionTask>()([
  "id",
  "toolKey",
  "kind",
  "source",
  "preview",
  "status",
  "startedAtMs",
  "finishedAtMs",
  "exitCode",
  "errorMessage",
  "logTruncated",
]);
const PLAN = keysOf<InstallPlan>()([
  "toolKey",
  "kind",
  "program",
  "args",
  "fingerprint",
  "source",
  "preview",
]);
const CLI_STATUS = keysOf<CliStatus>()([
  "toolKey",
  "status",
  "path",
  "resolvedCommand",
  "version",
  "versionError",
  "latestVersion",
]);
const REFRESH = keysOf<SessionSearchIndexRefresh>()([
  "incompleteTools",
  "indexedSessions",
]);
const PATH_SEMANTICS = keysOf<PathSemantics>()([
  "case",
  "normalizationInsensitive",
]);
const LISTING = keysOf<ProjectDirectoryListing>()([
  "entries",
  "truncated",
  "skippedCount",
  "pathSemantics",
]);
const FILE_ENTRY = keysOf<ProjectFileEntry>()([
  "name",
  "relativePath",
  "kind",
  "size",
  "hidden",
  "ignored",
  "symbolicLink",
]);
const RESIDUE_LISTING = keysOf<ProjectFileCasResidueListing>()([
  "entries",
  "truncated",
  "skippedCount",
]);
const RESIDUE = keysOf<ProjectFileCasResidue>()([
  "relativePath",
  "sizeBytes",
  "modifiedAtMs",
  "fileIdentity",
]);
const PAGE = keysOf<SessionPage>()(["items", "nextCursor"]);
const SESSION_INFO = keysOf<SessionInfo>()([
  "toolKey",
  "sessionId",
  "title",
  "alias",
  "lastActiveMs",
]);
const SEARCH = keysOf<SessionSearchResults>()(["items", "incompleteTools"]);
const DETAIL = keysOf<ExecutionTaskDetail>()(["task", "logs"]);
const STATE_READ = keysOf<WorkspaceLayoutStateRead>()([
  "status",
  "revision",
  "schemaVersion",
  "updatedAtMs",
  "layout",
  "slotStates",
]);
const SLOT_STATE = keysOf<WorkspaceSlotState>()([
  "instanceId",
  "state",
  "currentProjectName",
]);
// Commands whose results had no fixture before R-1 (m6-071) enforced one.
const SEND_RESULT = keysOf<SendWindowMessageResult>()(["delivered"]);
const STARTUP_NOTICE = keysOf<StartupNotice>()(["kind", "startedAtMs"]);
const INBOX_SUBSCRIPTION = keysOf<WindowInboxSubscription>()([
  "replaced",
  "flushed",
  "dropped",
]);

/** 一般结构体：每个 case 的键集合等于 TypeScript 类型的键集合；nested 检查嵌套对象。 */
const STRUCTS: Array<{
  file: string;
  type: string;
  keys: readonly string[];
  nested?: (value: Record<string, unknown>, label: string) => void;
}> = [
  { file: "directory.json", type: "Directory", keys: DIRECTORY },
  { file: "backup-manifest.json", type: "BackupManifest", keys: BACKUP },
  {
    file: "workspace-layout-preset-summary.json",
    type: "WorkspaceLayoutPresetSummary",
    keys: PRESET,
  },
  {
    file: "launch-history-entry.json",
    type: "LaunchHistoryEntry",
    keys: HISTORY,
  },
  { file: "cache-stats.json", type: "CacheStats", keys: CACHE },
  { file: "pty-handoff.json", type: "PtyHandoff", keys: HANDOFF },
  { file: "pty-session.json", type: "PtySession", keys: SESSION },
  {
    file: "execution-log-chunk.json",
    type: "ExecutionLogChunk",
    keys: LOG_CHUNK,
  },
  { file: "execution-task.json", type: "ExecutionTask", keys: TASK },
  { file: "install-plan.json", type: "InstallPlan", keys: PLAN },
  { file: "cli-status.json", type: "CliStatus", keys: CLI_STATUS },
  {
    file: "session-search-index-refresh.json",
    type: "SessionSearchIndexRefresh",
    keys: REFRESH,
  },
  {
    file: "send-window-message-result.json",
    type: "SendWindowMessageResult",
    keys: SEND_RESULT,
  },
  { file: "startup-notice.json", type: "StartupNotice", keys: STARTUP_NOTICE },
  {
    file: "window-inbox-subscription.json",
    type: "WindowInboxSubscription",
    keys: INBOX_SUBSCRIPTION,
  },
  {
    file: "project-directory-listing.json",
    type: "ProjectDirectoryListing",
    keys: LISTING,
    nested: (value, label) => {
      for (const entry of value.entries as unknown[])
        expectKeys(`${label}.entries[]`, entry, FILE_ENTRY);
      expectKeys(`${label}.pathSemantics`, value.pathSemantics, PATH_SEMANTICS);
    },
  },
  { file: "path-semantics.json", type: "PathSemantics", keys: PATH_SEMANTICS },
  {
    file: "project-file-cas-residue-listing.json",
    type: "ProjectFileCasResidueListing",
    keys: RESIDUE_LISTING,
    nested: (value, label) => {
      for (const entry of value.entries as unknown[])
        expectKeys(`${label}.entries[]`, entry, RESIDUE);
    },
  },
  {
    file: "session-page.json",
    type: "SessionPage",
    keys: PAGE,
    nested: (value, label) => {
      for (const item of value.items as unknown[])
        expectKeys(`${label}.items[]`, item, SESSION_INFO);
    },
  },
  {
    file: "session-search-results.json",
    type: "SessionSearchResults",
    keys: SEARCH,
    nested: (value, label) => {
      for (const item of value.items as unknown[])
        expectKeys(`${label}.items[]`, item, SESSION_INFO);
    },
  },
  {
    file: "execution-task-detail.json",
    type: "ExecutionTaskDetail",
    keys: DETAIL,
    nested: (value, label) => {
      expectKeys(`${label}.task`, value.task, TASK);
      for (const log of value.logs as unknown[])
        expectKeys(`${label}.logs[]`, log, LOG_CHUNK);
    },
  },
];

describe("Rust-serialized DTO fixtures match the TypeScript types", () => {
  it.each(STRUCTS)(
    "$type has exactly the TypeScript keys in every case",
    ({ file, type, keys, nested }) => {
      const entry = fixtureFiles[`../../contracts/fixtures/${file}`];
      expect(entry.type).toBe(type);
      for (const { name, value } of cases(file)) {
        const label = `${type}.${name}`;
        expectKeys(label, value, keys);
        nested?.(value as Record<string, unknown>, label);
      }
    },
  );

  it("matches the ProjectFileOpenResult variants", () => {
    const text = keysOf<Extract<ProjectFileOpenResult, { kind: "text" }>>()([
      "kind",
      "content",
      "revision",
    ]);
    const image = keysOf<Extract<ProjectFileOpenResult, { kind: "image" }>>()([
      "kind",
      "mimeType",
      "base64Data",
    ]);
    const unsupported = keysOf<
      Extract<ProjectFileOpenResult, { kind: "unsupported" }>
    >()(["kind", "reason"]);
    const byKind: Record<string, readonly string[]> = {
      text,
      image,
      unsupported,
    };
    const seen = new Set<string>();
    for (const { name, value } of cases("project-file-open-result.json")) {
      const kind = (value as { kind: string }).kind;
      expect(byKind[kind], `${name} 的 kind ${kind} 未登记`).toBeDefined();
      expectKeys(name, value, byKind[kind]);
      seen.add(kind);
    }
    expect([...seen].sort()).toEqual(["image", "text", "unsupported"]);
  });

  it("matches the ProjectTextFileSaveResult variants", () => {
    const saved = keysOf<
      Extract<ProjectTextFileSaveResult, { kind: "saved" }>
    >()(["kind", "content", "revision", "warning"]);
    const conflict = keysOf<
      Extract<ProjectTextFileSaveResult, { kind: "conflict" }>
    >()(["kind"]);
    const byKind: Record<string, readonly string[]> = { saved, conflict };
    const seen = new Set<string>();
    for (const { name, value } of cases("project-text-file-save-result.json")) {
      const kind = (value as { kind: string }).kind;
      expect(byKind[kind], `${name} 的 kind ${kind} 未登记`).toBeDefined();
      expectKeys(name, value, byKind[kind]);
      seen.add(kind);
    }
    expect([...seen].sort()).toEqual(["conflict", "saved"]);
  });

  it("matches the PtyEvent variants", () => {
    const output = keysOf<Extract<PtyEvent, { type: "output" }>>()([
      "type",
      "sessionId",
      "sequence",
      "dataBase64",
    ]);
    const snapshot = keysOf<Extract<PtyEvent, { type: "snapshot" }>>()([
      "type",
      "sessionId",
      "sequence",
      "data",
      "cols",
      "rows",
    ]);
    const exited = keysOf<Extract<PtyEvent, { type: "exited" }>>()([
      "type",
      "sessionId",
      "state",
      "exitCode",
    ]);
    const failed = keysOf<Extract<PtyEvent, { type: "failed" }>>()([
      "type",
      "sessionId",
      "message",
    ]);
    const byType: Record<string, readonly string[]> = {
      output,
      snapshot,
      exited,
      failed,
    };
    const seen = new Set<string>();
    for (const { name, value } of cases("pty-event.json")) {
      const type = (value as { type: string }).type;
      expect(byType[type], `${name} 的 type ${type} 未登记`).toBeDefined();
      expectKeys(name, value, byType[type]);
      seen.add(type);
    }
    expect([...seen].sort()).toEqual([
      "exited",
      "failed",
      "output",
      "snapshot",
    ]);
  });

  it("matches the LatestVersion fields and managedUpdate variants", () => {
    const latest = keysOf<LatestVersion>()([
      "toolKey",
      "latest",
      "updateAvailability",
      "commitsBehind",
      "error",
      "fromCache",
      "managedUpdate",
    ]);
    const allowed = keysOf<
      Extract<LatestVersion["managedUpdate"], { status: "allowed" }>
    >()(["status"]);
    const denied = keysOf<
      Extract<LatestVersion["managedUpdate"], { status: "denied" }>
    >()(["status", "reasonKey"]);
    const notApplicable = keysOf<
      Extract<LatestVersion["managedUpdate"], { status: "notApplicable" }>
    >()(["status"]);
    const byStatus: Record<string, readonly string[]> = {
      allowed,
      denied,
      notApplicable,
    };
    for (const { name, value } of cases("latest-version.json")) {
      expectKeys(name, value, latest);
      const managed = (value as { managedUpdate: { status: string } })
        .managedUpdate;
      expect(
        byStatus[managed.status],
        `${name} 的状态 ${managed.status} 未登记`,
      ).toBeDefined();
      expectKeys(`${name}.managedUpdate`, managed, byStatus[managed.status]);
    }
  });

  it("matches the FileIdentityComparison values", () => {
    const values: FileIdentityComparison[] = cases(
      "file-identity-comparison.json",
    ).map(({ value }) => value as FileIdentityComparison);
    expect([...values].sort()).toEqual(["different", "same", "unavailable"]);
  });

  it("matches the CloseBehavior values", () => {
    const values = cases("close-behavior.json").map(({ value }) => value);
    expect(values.sort()).toEqual(["minimize_to_tray", "quit"]);
  });

  it("matches the WorkspaceLayoutStateRead statuses and slot states", () => {
    for (const { name, value } of cases("workspace-layout-state-read.json")) {
      expectKeys(name, value, STATE_READ);
      const read = value as {
        status: { status: string };
        slotStates: unknown[];
      };
      expect(["missing", "ready", "needsReset"], name).toContain(
        read.status.status,
      );
      for (const slot of read.slotStates)
        expectKeys(`${name}.slotStates[]`, slot, SLOT_STATE);
    }
  });

  it("covers every struct fixture file in the table or an explicit variant test", () => {
    const COVERED_ELSEWHERE = [
      "managed-update-status.json",
      "pty-session-window-status.json",
      "workspace-layout-apply-plan.json",
      "workspace-layout-save-result.json",
      "app-error.json",
      "exit-requested-payload.json",
      // m6-101: covered by the exit impacts parser test (FD-1) and the Rust golden fixture.
      "exit-impacts-view.json",
      "event-workspace-content-window-lost.json",
      "event-pty-session-owner-lost.json",
      "event-inbox-message.json",
      // The shared window envelope: covered by CH-9 (encoder and delivery) and by the Rust relay test.
      "content-handoff-pty-return-requested.json",
    ];
    const VARIANT_TESTS = [
      "project-file-open-result.json",
      "project-text-file-save-result.json",
      "pty-event.json",
      "latest-version.json",
      "close-behavior.json",
      "file-identity-comparison.json",
      "workspace-layout-state-read.json",
    ];
    const all = Object.keys(fixtureFiles).map(
      (path) => path.split("/").pop() as string,
    );
    const known = new Set([
      ...STRUCTS.map((entry) => entry.file),
      ...VARIANT_TESTS,
      ...COVERED_ELSEWHERE,
    ]);
    expect(all.filter((file) => !known.has(file))).toEqual([]);
    expect(all.length).toBe(39);
    expect(
      STRUCTS.length + VARIANT_TESTS.length + COVERED_ELSEWHERE.length,
    ).toBe(39);
  });
});

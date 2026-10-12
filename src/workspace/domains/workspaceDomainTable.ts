import type { RegisteredWorkspaceContentKind } from "../../components/workspaceContentAdapterRegistry";
import type { WorkspacePaneContentRef } from "../../lib/tauri";

export type WorkspaceContentRefOf<K extends RegisteredWorkspaceContentKind> =
  Extract<WorkspacePaneContentRef, { kind: K }>;

export type WorkspaceCloseOrigin = "tab" | "menu" | "stack" | "window";

/** What the host needs to know before asking the user to confirm a close. */
export interface WorkspaceCloseInput {
  title: string;
  isDirty: boolean;
  isRunning: boolean;
}

export interface WorkspaceCloseResult {
  closed: WorkspacePaneContentRef[];
  pending: WorkspacePaneContentRef[];
  failed: WorkspacePaneContentRef[];
}

export interface WorkspaceContentDomain<
  K extends RegisteredWorkspaceContentKind,
> {
  readonly kind: K;
  /** undefined: the content must not be closed through the generic path. */
  closeInput: (
    ref: WorkspaceContentRefOf<K>,
  ) => WorkspaceCloseInput | undefined;
  /** Runs after the user approved; commits domain state and reports outcomes. */
  close: (
    refs: WorkspaceContentRefOf<K>[],
    origin: WorkspaceCloseOrigin,
  ) => Promise<WorkspaceCloseResult>;
}

export type WorkspaceDomainTable = {
  [K in RegisteredWorkspaceContentKind]: WorkspaceContentDomain<K>;
};

export function createWorkspaceDomainTable(
  table: WorkspaceDomainTable,
): WorkspaceDomainTable {
  return table;
}

/** Kinds in insertion order of the table (file before pty, the HEAD close order). */
export function workspaceDomainKinds(
  table: WorkspaceDomainTable,
): RegisteredWorkspaceContentKind[] {
  return Object.keys(table) as RegisteredWorkspaceContentKind[];
}

export function getWorkspaceDomain(
  table: WorkspaceDomainTable,
  kind: string,
): WorkspaceContentDomain<any> | undefined {
  return (table as Record<string, WorkspaceContentDomain<any> | undefined>)[
    kind
  ];
}

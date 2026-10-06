import type { ReactNode } from "react";
import type {
  PtySession,
  ToolKey,
  WorkspaceFileDocument,
  WorkspacePaneContentRef,
  WorkspaceSlotStateKind,
} from "../lib/tauri";
import type { WorkspaceFileBuffer } from "../lib/workspaceFileBuffer";
import type {
  WorkspaceContentBeforeCloseHook,
  WorkspaceContentDisposalImpact,
  WorkspaceContentDisposeContext,
  WorkspaceContentWindowBeforeCloseHook,
} from "../lib/workspaceContentClose";
import type {
  WorkspaceContentHandoffPayloadByKind,
  WorkspaceContentOwner,
} from "../lib/workspaceContentLifecycle";

export interface WorkspaceContentRenderContext {
  content: WorkspacePaneContentRef;
  pty?: {
    portalTarget: HTMLElement | undefined;
  };
  file?: {
    document: WorkspaceFileDocument | undefined;
    buffer: WorkspaceFileBuffer | undefined;
    readOnly: boolean;
    edit: (documentId: string, content: string) => void;
    save: (documentId: string) => Promise<void>;
  };
}

export interface WorkspaceContentAdapterLabels {
  menu: string;
  close: string;
  closeCurrent: string;
  closeOthers: string;
  closeAll: string;
  splitAndMoveRight: string;
  splitAndMoveDown: string;
}

export type RegisteredWorkspaceContentKind = "pty" | "file";

export interface WorkspaceContentPresentationContext {
  directories: readonly { id: number; name: string }[];
  ptySlots: readonly {
    instanceId: string;
    directoryId: number;
    projectName: string;
    toolKey: ToolKey;
    sequence: number;
    title: { kind: "automatic" } | { kind: "custom"; value: string };
    sessionId?: string | null;
    restoredState?: WorkspaceSlotStateKind;
  }[];
  ptySessionsById: Record<string, PtySession>;
  fileDocuments: readonly WorkspaceFileDocument[];
  fileBuffers: Readonly<Record<string, WorkspaceFileBuffer | undefined>>;
  selectedDirectoryId: number | null;
}

export interface WorkspaceContentPresentation {
  title: string;
  icon: ReactNode;
  status?: "running" | "failed" | "dirty";
  tooltip?: string;
  closeLabelKey: string;
}

export interface WorkspaceContentHandoffHookContext<
  Kind extends RegisteredWorkspaceContentKind = RegisteredWorkspaceContentKind,
> {
  content: Extract<WorkspacePaneContentRef, { kind: Kind }>;
  source: WorkspaceContentOwner;
  target: WorkspaceContentOwner;
  transferId: string;
  capabilities: WorkspaceContentHandoffCapabilitiesByKind[Kind];
}

export interface WorkspaceContentHandoffCapabilitiesByKind {
  pty: {
    prepare: () => Promise<WorkspaceContentHandoffPayloadByKind["pty"]>;
    attach: (
      payload: WorkspaceContentHandoffPayloadByKind["pty"],
    ) => Promise<void>;
    rollback: (
      payload: WorkspaceContentHandoffPayloadByKind["pty"] | undefined,
      reason: unknown,
    ) => Promise<void>;
  };
  file: {
    prepare: () => Promise<WorkspaceContentHandoffPayloadByKind["file"]>;
    attach: (
      payload: WorkspaceContentHandoffPayloadByKind["file"],
    ) => Promise<void>;
    rollback: (
      payload: WorkspaceContentHandoffPayloadByKind["file"] | undefined,
      reason: unknown,
    ) => Promise<void>;
  };
}

export interface WorkspaceContentPreparedHandoff<
  Kind extends RegisteredWorkspaceContentKind,
> {
  transferId: string;
  payload: WorkspaceContentHandoffPayloadByKind[Kind];
}

export interface WorkspaceContentAdapterLifecycle<
  Kind extends RegisteredWorkspaceContentKind = RegisteredWorkspaceContentKind,
> {
  beforeClose?: WorkspaceContentBeforeCloseHook;
  describeDisposalImpact?: (context: {
    isDirty: boolean;
    isRunning: boolean;
    title: string;
  }) => WorkspaceContentDisposalImpact[];
  beforeWindowClose?: WorkspaceContentWindowBeforeCloseHook;
  prepareHandoff?: (
    context: WorkspaceContentHandoffHookContext<Kind>,
  ) => Promise<WorkspaceContentPreparedHandoff<Kind>>;
  attachHandoff?: (
    context: WorkspaceContentHandoffHookContext<Kind>,
    payload: WorkspaceContentHandoffPayloadByKind[Kind],
  ) => Promise<void>;
  rollbackHandoff?: (
    context: WorkspaceContentHandoffHookContext<Kind>,
    payload: WorkspaceContentHandoffPayloadByKind[Kind] | undefined,
    reason: unknown,
  ) => Promise<void>;
  dispose?: (
    context: WorkspaceContentDisposeContext<Kind>,
  ) => void | Promise<void>;
}

export interface WorkspaceContentAdapter<
  Kind extends RegisteredWorkspaceContentKind = RegisteredWorkspaceContentKind,
> {
  id: string;
  apiVersion: 2;
  kind: Kind;
  render: (context: WorkspaceContentRenderContext) => ReactNode;
  presentation: (
    content: Extract<WorkspacePaneContentRef, { kind: Kind }>,
    context: WorkspaceContentPresentationContext,
  ) => WorkspaceContentPresentation;
  labels: WorkspaceContentAdapterLabels;
  projectContextOf: (
    content: Extract<WorkspacePaneContentRef, { kind: Kind }>,
    context: WorkspaceContentPresentationContext,
  ) => number | null;
  lifecycle?: WorkspaceContentAdapterLifecycle<Kind>;
}

const adaptersByKind = new Map<
  RegisteredWorkspaceContentKind,
  WorkspaceContentAdapter<any>
>();
const adaptersById = new Map<string, WorkspaceContentAdapter<any>>();
const listeners = new Set<() => void>();
let revision = 0;

function notifyRegistryChanged() {
  revision += 1;
  listeners.forEach((listener) => listener());
}

export function registerWorkspaceContentAdapter<
  Kind extends RegisteredWorkspaceContentKind,
>(adapter: WorkspaceContentAdapter<Kind>): () => void {
  if (!adapter.id.trim()) throw new Error("内容适配器 ID 不能为空");
  if (adapter.apiVersion !== 2) {
    throw new Error(`不支持内容适配器 API 版本: ${adapter.apiVersion}`);
  }
  if (adaptersById.has(adapter.id)) {
    throw new Error(`内容适配器 ID 已注册: ${adapter.id}`);
  }
  if (adaptersByKind.has(adapter.kind)) {
    throw new Error(`内容类型已注册: ${adapter.kind}`);
  }
  const handoffHooks = [
    adapter.lifecycle?.prepareHandoff,
    adapter.lifecycle?.attachHandoff,
    adapter.lifecycle?.rollbackHandoff,
  ];
  if (handoffHooks.some(Boolean) && !handoffHooks.every(Boolean)) {
    throw new Error(`内容适配器 handoff 生命周期钩子不完整: ${adapter.kind}`);
  }

  adaptersById.set(adapter.id, adapter);
  adaptersByKind.set(adapter.kind, adapter);
  notifyRegistryChanged();
  return () => {
    if (adaptersById.get(adapter.id) !== adapter) return;
    adaptersById.delete(adapter.id);
    adaptersByKind.delete(adapter.kind);
    notifyRegistryChanged();
  };
}

export function getWorkspaceContentAdapter<
  Kind extends RegisteredWorkspaceContentKind,
>(kind: Kind): WorkspaceContentAdapter<Kind> {
  const adapter = tryGetWorkspaceContentAdapter(kind);
  if (!adapter) throw new Error(`未注册内容适配器: ${kind}`);
  return adapter as WorkspaceContentAdapter<Kind>;
}

export function tryGetWorkspaceContentAdapter<
  Kind extends RegisteredWorkspaceContentKind,
>(kind: Kind): WorkspaceContentAdapter<Kind> | undefined {
  return adaptersByKind.get(kind) as WorkspaceContentAdapter<Kind> | undefined;
}

export function presentWorkspaceContent(
  content: WorkspacePaneContentRef,
  context: WorkspaceContentPresentationContext,
): WorkspaceContentPresentation {
  if (content.kind === "pty") {
    return (
      tryGetWorkspaceContentAdapter("pty")?.presentation(content, context) ?? {
        title: content.kind,
        icon: null,
        tooltip: content.kind,
        closeLabelKey: "workspaceContent.closeUnsupported",
      }
    );
  }
  if (content.kind === "file") {
    return (
      tryGetWorkspaceContentAdapter("file")?.presentation(content, context) ?? {
        title: content.kind,
        icon: null,
        tooltip: content.kind,
        closeLabelKey: "workspaceContent.closeUnsupported",
      }
    );
  }
  return {
    title: content.originalKind,
    icon: null,
    tooltip: content.originalKind,
    closeLabelKey: "workspaceContent.closeUnsupported",
  };
}

export function workspaceContentProjectContext(
  content: WorkspacePaneContentRef,
  context: WorkspaceContentPresentationContext,
): number | null {
  if (content.kind === "pty") {
    return (
      tryGetWorkspaceContentAdapter("pty")?.projectContextOf(
        content,
        context,
      ) ?? null
    );
  }
  if (content.kind === "file") {
    return (
      tryGetWorkspaceContentAdapter("file")?.projectContextOf(
        content,
        context,
      ) ?? null
    );
  }
  return null;
}

export function getWorkspaceContentAdapterRevision(): number {
  return revision;
}

export function subscribeWorkspaceContentAdapters(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

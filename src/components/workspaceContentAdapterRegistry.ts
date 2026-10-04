import type { ReactNode } from "react";
import type {
  WorkspaceFileDocument,
  WorkspacePaneContentRef,
} from "../lib/tauri";
import type { WorkspaceFileBuffer } from "../lib/workspaceFileBuffer";
import type {
  WorkspaceContentBeforeCloseHook,
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

export interface WorkspaceContentHandoffHookContext<
  Kind extends WorkspacePaneContentRef["kind"] =
    WorkspacePaneContentRef["kind"],
> {
  content: Extract<WorkspacePaneContentRef, { kind: Kind }>;
  source: WorkspaceContentOwner;
  target: WorkspaceContentOwner;
  transferId: string;
  generation: number;
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
  Kind extends WorkspacePaneContentRef["kind"],
> {
  transferId: string;
  payload: WorkspaceContentHandoffPayloadByKind[Kind];
}

export interface WorkspaceContentAdapterLifecycle<
  Kind extends WorkspacePaneContentRef["kind"] =
    WorkspacePaneContentRef["kind"],
> {
  beforeClose?: WorkspaceContentBeforeCloseHook;
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
  Kind extends WorkspacePaneContentRef["kind"] =
    WorkspacePaneContentRef["kind"],
> {
  id: string;
  apiVersion: 1;
  kind: Kind;
  render: (context: WorkspaceContentRenderContext) => ReactNode;
  presentation: {
    labels: WorkspaceContentAdapterLabels;
  };
  lifecycle?: WorkspaceContentAdapterLifecycle<Kind>;
}

const adaptersByKind = new Map<
  WorkspaceContentAdapter["kind"],
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
  Kind extends WorkspacePaneContentRef["kind"],
>(adapter: WorkspaceContentAdapter<Kind>): () => void {
  if (!adapter.id.trim()) throw new Error("内容适配器 ID 不能为空");
  if (adapter.apiVersion !== 1) {
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
  Kind extends WorkspaceContentAdapter["kind"],
>(kind: Kind): WorkspaceContentAdapter<Kind> {
  const adapter = adaptersByKind.get(kind);
  if (!adapter) throw new Error(`未注册内容适配器: ${kind}`);
  return adapter as WorkspaceContentAdapter<Kind>;
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

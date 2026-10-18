import type { ReactNode } from "react";
import { createRegistry } from "../lib/createRegistry";
import { safeAdapterCall } from "../lib/safeAdapterCall";
import { WORKSPACE_CONTENT_ADAPTER_API_VERSION } from "../lib/extensionApiVersions";
import { registeredContentKinds } from "../lib/windowKinds";
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
  apiVersion: 3;
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

const registry = createRegistry<WorkspaceContentAdapter<any>>({
  name: "workspaceContentAdapter",
  supportedApiVersions: [WORKSPACE_CONTENT_ADAPTER_API_VERSION],
  messages: {
    emptyId: "内容适配器 ID 不能为空",
    unsupportedApiVersion: (apiVersion) =>
      `不支持内容适配器 API 版本: ${apiVersion}`,
    duplicateId: (id) => `内容适配器 ID 已注册: ${id}`,
    duplicateKey: (kind) => `内容类型已注册: ${kind}`,
  },
  keyOf: (adapter) => adapter.kind,
  validate: (adapter) => {
    if (!registeredContentKinds().includes(adapter.kind)) {
      throw new Error(`内容类型未在契约登记: ${adapter.kind}`);
    }
    const handoffHooks = [
      adapter.lifecycle?.prepareHandoff,
      adapter.lifecycle?.attachHandoff,
      adapter.lifecycle?.rollbackHandoff,
    ];
    if (handoffHooks.some(Boolean) && !handoffHooks.every(Boolean)) {
      throw new Error(`内容适配器 handoff 生命周期钩子不完整: ${adapter.kind}`);
    }
  },
});

export function registerWorkspaceContentAdapter<
  Kind extends RegisteredWorkspaceContentKind,
>(adapter: WorkspaceContentAdapter<Kind>): () => void {
  return registry.register(adapter);
}

export function listWorkspaceContentAdapters(): readonly WorkspaceContentAdapter<any>[] {
  return registry.list();
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
  return registry.getByKey(kind) as WorkspaceContentAdapter<Kind> | undefined;
}

function unsupportedPresentation(kind: string): WorkspaceContentPresentation {
  return {
    title: kind,
    icon: null,
    tooltip: kind,
    closeLabelKey: "workspaceContent.closeUnsupported",
  };
}

export function presentWorkspaceContent(
  content: WorkspacePaneContentRef,
  context: WorkspaceContentPresentationContext,
): WorkspaceContentPresentation {
  if (content.kind === "unknown") {
    return unsupportedPresentation(content.originalKind);
  }
  const adapter = tryGetWorkspaceContentAdapter(content.kind) as
    | WorkspaceContentAdapter<any>
    | undefined;
  if (!adapter) return unsupportedPresentation(content.kind);
  // An adapter that throws must not take the whole workspace render down (render has an
  // ErrorBoundary, these synchronous hooks did not): degrade to the "unsupported" placeholder.
  return safeAdapterCall(
    `presentation:${content.kind}`,
    () =>
      adapter.presentation(content, context) ??
      unsupportedPresentation(content.kind),
    () => unsupportedPresentation(content.kind),
  );
}

export function workspaceContentProjectContext(
  content: WorkspacePaneContentRef,
  context: WorkspaceContentPresentationContext,
): number | null {
  if (content.kind === "unknown") return null;
  const adapter = tryGetWorkspaceContentAdapter(content.kind) as
    | WorkspaceContentAdapter<any>
    | undefined;
  if (!adapter) return null;
  return safeAdapterCall(
    `projectContext:${content.kind}`,
    () => adapter.projectContextOf(content, context) ?? null,
    () => null,
  );
}

export function getWorkspaceContentAdapterRevision(): number {
  return registry.revision();
}

export function subscribeWorkspaceContentAdapters(
  listener: () => void,
): () => void {
  return registry.subscribe(listener);
}

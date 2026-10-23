import type { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { WorkspaceContentWindowRecord } from "../../lib/workspaceContentWindowRegistry";
import type { PendingWindowStage } from "../../lib/workspaceContentPendingStage";
import type { WorkspaceContentHandoffPayloadByKind } from "../../lib/workspaceContentLifecycle";
import type { WorkspaceContentHandoffHookContext } from "../../components/workspaceContentAdapterRegistry";
import type { RegisteredContentKind } from "../../generated/contentKinds";

/** Window and handoff records shared by the content window orchestrator and its protocol handlers. */
export interface DetachedWindowRecord {
  instanceId: string;
  sessionId: string;
  windowLabel: string;
}

export interface PendingContentWindow<
  K extends RegisteredContentKind,
> extends WorkspaceContentWindowRecord {
  kind: K;
  stage: PendingWindowStage;
  transferId: string;
  window: WebviewWindow;
  resolve: () => void;
  reject: (reason: Error) => void;
  handoffContext?: WorkspaceContentHandoffHookContext<K>;
  handoffPayload?: WorkspaceContentHandoffPayloadByKind[K];
}

export type PendingDetachedWindow = PendingContentWindow<"pty"> &
  DetachedWindowRecord & {
    handoffContext: WorkspaceContentHandoffHookContext<"pty">;
    handoffPayload: WorkspaceContentHandoffPayloadByKind["pty"];
    /** The Rust handoff token that attaches the PTY back. */
    handoffToken: string;
    windowToken: string;
    /** 对账时 owner 查询已连续失败的次数；随 tracked 展开复制。 */
    ownerQueryRetries?: number;
  };

export interface DetachedWindowReadyEvent extends DetachedWindowRecord {}

export interface PtySessionOwnerLostEvent {
  sessionId: string;
}

export interface PtyReturnRequestEvent extends DetachedWindowRecord {
  token: string;
  handoffToken: string;
  targetPaneId?: string;
}

export interface PendingWorkspaceFileWindow extends PendingContentWindow<"file"> {
  documentId: string;
  /** The window session token; the child window echoes it back. */
  windowToken: string;
  sourcePaneId?: string;
}
export interface ManagedFileWindow {
  documentId: string;
  token: string;
  windowLabel: string;
}

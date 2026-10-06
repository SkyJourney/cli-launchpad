import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getWindowChromeOptions } from "../lib/windowChrome";
import type { WorkspaceContentHandoffPayloadByKind } from "../lib/workspaceContentLifecycle";
import {
  getWorkspaceContentAdapter,
  type RegisteredWorkspaceContentKind,
  type WorkspaceContentAdapter,
  type WorkspaceContentHandoffHookContext,
  type WorkspaceContentPreparedHandoff,
} from "./workspaceContentAdapterRegistry";

export const WORKSPACE_CONTENT_WINDOW_HANDOFF_TIMEOUT_MS = 15_000;

export interface WorkspaceContentWindowOptions {
  label: string;
  url: string;
  title: string;
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
}

/** Creates every detached content window with the same platform chrome policy. */
export function createWorkspaceContentWindow({
  label,
  url,
  title,
  width = 1100,
  height = 760,
  minWidth = 560,
  minHeight = 360,
}: WorkspaceContentWindowOptions): WebviewWindow {
  const chromeOptions = getWindowChromeOptions(navigator.userAgent);
  return new WebviewWindow(label, {
    ...chromeOptions,
    url,
    title,
    width,
    height,
    minWidth,
    minHeight,
    dragDropEnabled: false,
  });
}

type ContentKind = RegisteredWorkspaceContentKind;

function getLifecycle<Kind extends ContentKind>(
  adapter: WorkspaceContentAdapter<Kind>,
) {
  const lifecycle = adapter.lifecycle;
  if (
    !lifecycle?.prepareHandoff ||
    !lifecycle.attachHandoff ||
    !lifecycle.rollbackHandoff
  ) {
    throw new Error(`内容适配器缺少 handoff driver: ${adapter.kind}`);
  }
  return lifecycle as Required<
    Pick<
      NonNullable<WorkspaceContentAdapter<Kind>["lifecycle"]>,
      "prepareHandoff" | "attachHandoff" | "rollbackHandoff"
    >
  >;
}

export function prepareWorkspaceContentHandoff<Kind extends ContentKind>(
  context: WorkspaceContentHandoffHookContext<Kind>,
): Promise<WorkspaceContentPreparedHandoff<Kind>> {
  const adapter = getWorkspaceContentAdapter(
    (context.content as { kind: ContentKind }).kind,
  ) as unknown as WorkspaceContentAdapter<Kind>;
  return getLifecycle(adapter).prepareHandoff(context);
}

export function attachWorkspaceContentHandoff<Kind extends ContentKind>(
  context: WorkspaceContentHandoffHookContext<Kind>,
  payload: WorkspaceContentHandoffPayloadByKind[Kind],
): Promise<void> {
  const adapter = getWorkspaceContentAdapter(
    (context.content as { kind: ContentKind }).kind,
  ) as unknown as WorkspaceContentAdapter<Kind>;
  return getLifecycle(adapter).attachHandoff(context, payload);
}

export function rollbackWorkspaceContentHandoff<Kind extends ContentKind>(
  context: WorkspaceContentHandoffHookContext<Kind>,
  payload: WorkspaceContentHandoffPayloadByKind[Kind] | undefined,
  reason: unknown,
): Promise<void> {
  const adapter = getWorkspaceContentAdapter(
    (context.content as { kind: ContentKind }).kind,
  ) as unknown as WorkspaceContentAdapter<Kind>;
  return getLifecycle(adapter).rollbackHandoff(context, payload, reason);
}

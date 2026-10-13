import { contentRefFromKey } from "./workspaceContentKey";

export const WORKSPACE_CONTENT_DRAG_TYPE =
  "application/x-cli-launchpad-workspace-content";

export type WorkspaceContentDragPayload =
  | { key: string; sourceWindowLabel: "main"; sourcePaneId: string }
  | { key: string; sourceWindowLabel: string };

const DRAG_PREFIX = "cli-launchpad-content-v2:";

export function encodeWorkspaceContentDrag(
  payload: WorkspaceContentDragPayload,
): string {
  return DRAG_PREFIX + JSON.stringify(payload);
}

export function parseWorkspaceContentDrag(
  raw: string,
): WorkspaceContentDragPayload | null {
  if (!raw.startsWith(DRAG_PREFIX) || raw.length > 1024) return null;
  try {
    const value: unknown = JSON.parse(raw.slice(DRAG_PREFIX.length));
    if (!value || typeof value !== "object") return null;
    const data = value as Record<string, unknown>;
    if (typeof data.key !== "string" || !contentRefFromKey(data.key)) {
      return null;
    }
    if (data.sourceWindowLabel === "main") {
      if (typeof data.sourcePaneId !== "string" || !data.sourcePaneId) {
        return null;
      }
      return {
        key: data.key,
        sourceWindowLabel: "main",
        sourcePaneId: data.sourcePaneId,
      };
    }
    if (
      typeof data.sourceWindowLabel !== "string" ||
      !/^(terminal|workspace-content)-[0-9a-f-]{36}$/i.test(
        data.sourceWindowLabel,
      ) ||
      data.sourcePaneId !== undefined
    ) {
      return null;
    }
    return { key: data.key, sourceWindowLabel: data.sourceWindowLabel };
  } catch {
    return null;
  }
}

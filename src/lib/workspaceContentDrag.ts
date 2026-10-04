export const WORKSPACE_CONTENT_DRAG_TYPE =
  "application/x-cli-launchpad-workspace-content";

export type WorkspaceContentDragPayload =
  | {
      kind: "pty";
      contentId: string;
      sourcePaneId: string;
      sourceWindowLabel: "main";
    }
  | {
      kind: "file";
      contentId: string;
      sourcePaneId: string;
      sourceWindowLabel: "main";
    }
  | {
      kind: "pty" | "file";
      contentId: string;
      sourceWindowLabel: string;
    };

const DRAG_PREFIX = "cli-launchpad-content-v1:";

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
    if (
      (data.kind !== "pty" && data.kind !== "file") ||
      typeof data.contentId !== "string" ||
      !data.contentId
    ) {
      return null;
    }
    if (data.sourceWindowLabel === "main") {
      if (typeof data.sourcePaneId !== "string" || !data.sourcePaneId) {
        return null;
      }
      return {
        kind: data.kind,
        contentId: data.contentId,
        sourcePaneId: data.sourcePaneId,
        sourceWindowLabel: "main",
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
    return {
      kind: data.kind,
      contentId: data.contentId,
      sourceWindowLabel: data.sourceWindowLabel,
    };
  } catch {
    return null;
  }
}

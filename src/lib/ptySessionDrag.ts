import { windowKindOf } from "./windowKinds";

export const PTY_SESSION_DRAG_TYPE = "application/x-cli-launchpad-pty-session";

const DRAG_PREFIX = "cli-launchpad-pty-v1:";

export type PtySessionDrag =
  | {
      instanceId: string;
      sourcePaneId: string;
      sourceWindowLabel: "main";
    }
  | {
      instanceId: string;
      sourceWindowLabel: string;
    };

export function encodePtySessionDrag(payload: PtySessionDrag): string {
  return DRAG_PREFIX + JSON.stringify(payload);
}

export function parsePtySessionDrag(raw: string): PtySessionDrag | null {
  if (!raw.startsWith(DRAG_PREFIX) || raw.length > 1024) return null;
  try {
    const payload: unknown = JSON.parse(raw.slice(DRAG_PREFIX.length));
    if (!payload || typeof payload !== "object") return null;
    const data = payload as Record<string, unknown>;
    if (typeof data.instanceId !== "string" || !data.instanceId) return null;
    if (data.sourceWindowLabel === "main") {
      if (typeof data.sourcePaneId !== "string" || !data.sourcePaneId)
        return null;
      return {
        instanceId: data.instanceId,
        sourcePaneId: data.sourcePaneId,
        sourceWindowLabel: "main",
      };
    }
    if (
      typeof data.sourceWindowLabel !== "string" ||
      windowKindOf(data.sourceWindowLabel) !== "terminal" ||
      data.sourcePaneId !== undefined
    ) {
      return null;
    }
    return {
      instanceId: data.instanceId,
      sourceWindowLabel: data.sourceWindowLabel,
    };
  } catch {
    return null;
  }
}

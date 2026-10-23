import { type DragEvent as ReactDragEvent } from "react";
import {
  encodeWorkspaceContentDrag,
  WORKSPACE_CONTENT_DRAG_TYPE,
} from "../../lib/workspaceContentDrag";
import { ptyContentKey } from "../../lib/workspaceContentKey";
import { MAIN_WINDOW_LABEL } from "../../lib/windowKinds";

export function beginWorkspaceSessionDrag(
  event: ReactDragEvent<HTMLElement>,
  sourcePaneId: string,
  instanceId: string,
) {
  event.dataTransfer.effectAllowed = "move";
  const payload = encodeWorkspaceContentDrag({
    key: ptyContentKey(instanceId),
    sourcePaneId,
    sourceWindowLabel: MAIN_WINDOW_LABEL,
  });
  event.dataTransfer.setData(WORKSPACE_CONTENT_DRAG_TYPE, payload);
  event.dataTransfer.setData("text/plain", payload);
}

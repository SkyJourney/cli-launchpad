import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { WorkspaceEditorEngineProps } from "./workspaceEditorEngineRegistry";
import {
  getWorkspaceEditorEngineRevision,
  resolveEditorEngine,
  subscribeWorkspaceEditorEngines,
} from "./workspaceEditorEngineRegistry";

export { registerWorkspaceEditorEngine } from "./workspaceEditorEngineRegistry";

export function WorkspaceEditorSurface(props: WorkspaceEditorEngineProps) {
  const { t } = useTranslation();
  useSyncExternalStore(
    subscribeWorkspaceEditorEngines,
    getWorkspaceEditorEngineRevision,
    getWorkspaceEditorEngineRevision,
  );
  const engine = resolveEditorEngine();
  if (!engine) {
    return (
      <div className="pty-workspace-empty" role="status">
        {t("workspaceFiles.editorUnavailable")}
      </div>
    );
  }
  const Engine = engine.View;
  return <Engine {...props} />;
}

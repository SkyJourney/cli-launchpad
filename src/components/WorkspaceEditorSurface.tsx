import { useEffect, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { WorkspaceEditorEngineProps } from "./workspaceEditorEngineRegistry";
import {
  getWorkspaceEditorEngineRevision,
  recordEditorEngineUse,
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
  // Remember which engine renders the document so that dispose releases the same one.
  const engineId = engine?.id;
  useEffect(() => {
    if (engineId) recordEditorEngineUse(props.documentKey, engineId);
  }, [props.documentKey, engineId]);
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

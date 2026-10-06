import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import type { WorkspaceEditorEngine } from "../workspaceEditorEngineRegistry";
import { registerWorkspaceEditorEngine } from "../workspaceEditorEngineRegistry";

const LazyMonacoWorkspaceEditor = lazy(() =>
  import("../workspaceEditor/MonacoWorkspaceEditor").then((module) => ({
    default: module.MonacoWorkspaceEditor,
  })),
);

const monacoEngine: WorkspaceEditorEngine = {
  id: "core.monaco",
  apiVersion: 1,
  releaseDocument: async (documentKey) => {
    const { releaseMonacoWorkspaceDocument } =
      await import("../workspaceEditor/MonacoWorkspaceEditor");
    releaseMonacoWorkspaceDocument(documentKey);
  },
  View: function MonacoEngineView(props) {
    const { t } = useTranslation();
    return (
      <Suspense
        fallback={
          <div className="pty-workspace-empty" role="status">
            {t("workspaceFiles.loadingFile")}
          </div>
        }
      >
        <LazyMonacoWorkspaceEditor {...props} />
      </Suspense>
    );
  },
};

export function registerBuiltinWorkspaceEditorEngines(): () => void {
  return registerWorkspaceEditorEngine(monacoEngine);
}

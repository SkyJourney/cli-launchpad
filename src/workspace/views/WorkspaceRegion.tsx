import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useDirectories } from "../../hooks/queries";
import { listWorkspacePanes } from "../../lib/ptyWorkspaceLayout";
import { formatAppError, formatAppErrorState } from "../../lib/appErrors";
import { useAppStore } from "../../store/appStore";
import {
  usePtyWorkspace,
  useWorkspaceCommands,
} from "../host/workspaceContexts";
import { useWorkspaceSelector } from "../host/workspaceHostStore";
import { WorkspaceLayoutManager } from "./WorkspaceLayoutManager";
import { WorkspaceTreeView } from "./WorkspaceTreeView";

export function WorkspaceLayoutControls() {
  const hydrationStatus = useWorkspaceSelector(
    (snapshot) => snapshot.hydrationStatus,
  );
  const { getCurrentPresetLayout, applyWorkspaceLayoutPreset } =
    useWorkspaceCommands();

  if (hydrationStatus !== "ready") return null;
  return (
    <WorkspaceLayoutManager
      getCurrentLayout={getCurrentPresetLayout}
      onApply={applyWorkspaceLayoutPreset}
    />
  );
}

export function WorkspaceRegion() {
  const { t } = useTranslation();
  const {
    slots,
    fileDocuments,
    fileBuffers,
    isHandoffContent,
    isDetachedContent,
    tree,
    workspaceTreeRevision,
    focusedPaneId,
    hydrationStatus,
    hydrationError,
    layoutSaveError,
    layoutResetError,
    layoutResetPending,
    portalTargets,
    focusPane,
    splitPane,
    splitAndMoveContent,
    moveContent,
    hasDetachedSessions,
    isManagedDetachedContent,
    closingContentKeys,
    detachSession,
    detachFile,
    closeEmptyPane,
    updateSplitRatio,
    retryHydration,
    resetWorkspace,
    activateContent,
    closeContents,
    editFile,
    saveFile,
  } = usePtyWorkspace();
  const { data: directories } = useDirectories();
  const ptySessionsById = useWorkspaceSelector(
    (snapshot) => snapshot.ptySessionsById,
  );
  const selectedDirectoryId = useAppStore((state) => state.selectedDirectoryId);

  if (hydrationStatus === "loading") {
    return (
      <section
        className="pty-workspace-region"
        aria-label={t("pty.panelLabel")}
      >
        <div className="pty-workspace-loading" role="status">
          {t("pty.layoutLoading")}
        </div>
      </section>
    );
  }

  if (hydrationStatus === "loadFailed") {
    return (
      <section
        className="pty-workspace-region"
        aria-label={t("pty.panelLabel")}
      >
        <div className="pty-workspace-recovery-notice" role="alert">
          <p>
            {t("pty.layoutLoadFailed", {
              error: formatAppErrorState(hydrationError ?? { message: "" }, t),
            })}
          </p>
          <button
            type="button"
            className="pty-layout-action"
            onClick={retryHydration}
          >
            {t("pty.retryLayoutRead")}
          </button>
        </div>
      </section>
    );
  }

  const workspacePanes = listWorkspacePanes(tree);

  return (
    <section className="pty-workspace-region" aria-label={t("pty.panelLabel")}>
      {hydrationStatus === "needsReset" && (
        <div className="pty-workspace-recovery-notice" role="status">
          <p>
            {t("pty.layoutNeedsReset", {
              reason: formatAppErrorState(hydrationError ?? { message: "" }, t),
            })}
          </p>
          {layoutResetError && (
            <p>
              {t("pty.layoutResetFailed", {
                error: formatAppErrorState(layoutResetError, t),
              })}
            </p>
          )}
          <button
            type="button"
            className="pty-layout-action"
            disabled={layoutResetPending}
            onClick={() => {
              if (!window.confirm(t("pty.confirmLayoutReset"))) return;
              void resetWorkspace().catch((reason) =>
                toast.error(formatAppError(reason, t)),
              );
            }}
          >
            {layoutResetPending
              ? t("pty.layoutResetPending")
              : t("pty.resetLayout")}
          </button>
        </div>
      )}
      {hydrationStatus === "ready" && layoutSaveError && (
        <div className="pty-workspace-recovery-notice" role="status">
          {t("pty.layoutSaveFailed", {
            error: formatAppErrorState(layoutSaveError, t),
          })}
        </div>
      )}
      <div className="pty-workspace-tree">
        <WorkspaceTreeView
          key={workspaceTreeRevision}
          node={tree}
          slots={slots}
          fileDocuments={fileDocuments}
          fileBuffers={fileBuffers}
          isHandoffContent={isHandoffContent}
          isDetachedContent={isDetachedContent}
          closingContentKeys={closingContentKeys}
          focusedPaneId={focusedPaneId}
          portalTargets={portalTargets}
          canCloseEmptyPane={listWorkspacePanes(tree).length > 1}
          selectedDirectoryId={selectedDirectoryId}
          directories={directories ?? []}
          ptySessionsById={ptySessionsById}
          workspacePanes={workspacePanes}
          onFocusPane={focusPane}
          onActivateContent={activateContent}
          onCloseContents={closeContents}
          onDetachFile={(documentId) => {
            void detachFile(documentId).catch((reason) =>
              toast.error(formatAppError(reason, t)),
            );
          }}
          onEditFile={editFile}
          onSaveFile={saveFile}
          onSplitPane={splitPane}
          onSplitAndMoveContent={splitAndMoveContent}
          onMoveContent={moveContent}
          hasDetachedSessions={hasDetachedSessions}
          isManagedDetachedContent={isManagedDetachedContent}
          onDetachSession={(instanceId) => {
            void detachSession(instanceId).catch((reason) =>
              toast.error(formatAppError(reason, t)),
            );
          }}
          onCloseEmptyPane={closeEmptyPane}
          onSplitResize={updateSplitRatio}
        />
      </div>
    </section>
  );
}

import { useTranslation } from "react-i18next";
import { type WorkspaceContentDisposalImpact } from "../../lib/workspaceContentClose";

export function ImpactConfirmDialog({
  impacts,
  onCancel,
  onConfirm,
}: {
  impacts: WorkspaceContentDisposalImpact[];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const runningSessions = impacts.filter(
    (impact) => impact.kind === "runningPty",
  );
  const dirtyFiles = impacts.filter((impact) => impact.kind === "dirtyFile");

  return (
    <div className="app-exit-overlay">
      <section className="app-exit-dialog" role="alertdialog" aria-modal="true">
        <h2>{t("common.confirm")}</h2>
        {runningSessions.length > 0 && (
          <>
            <p>
              {t("pty.confirmCloseMany", { count: runningSessions.length })}
            </p>
            <ul className="app-exit-unsaved-files">
              {runningSessions.map((impact) => (
                <li key={`pty:${impact.title}`}>{impact.title}</li>
              ))}
            </ul>
          </>
        )}
        {dirtyFiles.length > 0 && (
          <>
            <p>{t("workspaceFiles.discardChanges")}</p>
            <ul className="app-exit-unsaved-files">
              {dirtyFiles.map((impact) => (
                <li key={`file:${impact.title}`}>{impact.title}</li>
              ))}
            </ul>
          </>
        )}
        <div className="app-exit-actions">
          <button className="ghost-button" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button className="primary-button" onClick={onConfirm}>
            {t("common.confirm")}
          </button>
        </div>
      </section>
    </div>
  );
}

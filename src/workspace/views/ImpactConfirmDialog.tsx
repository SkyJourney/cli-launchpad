import { useTranslation } from "react-i18next";
import { type WorkspaceContentDisposalImpact } from "../../lib/workspaceContentClose";
import { ImpactTitleList } from "../../components/ImpactTitleList";
import { summarizeDisposalImpacts } from "../impacts/impactSummary";

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
  const summary = summarizeDisposalImpacts(impacts);
  const runningCount = summary.runningPtys.count;
  const dirtyFiles = summary.dirtyFiles;

  return (
    <div className="app-exit-overlay">
      <section className="app-exit-dialog" role="alertdialog" aria-modal="true">
        <h2>{t("common.confirm")}</h2>
        {runningCount > 0 && (
          <>
            <p>{t("pty.confirmCloseMany", { count: runningCount })}</p>
            <ImpactTitleList
              items={summary.runningPtys.titles.map((title) => ({
                key: `pty:${title}`,
                title,
              }))}
            />
          </>
        )}
        {dirtyFiles.length > 0 && (
          <>
            <p>{t("workspaceFiles.discardChanges")}</p>
            <ImpactTitleList items={dirtyFiles} />
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

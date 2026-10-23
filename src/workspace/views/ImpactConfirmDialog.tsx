import { useTranslation } from "react-i18next";
import { type WorkspaceContentDisposalImpact } from "../../lib/workspaceContentClose";
import { ImpactTitleList } from "../../components/ImpactTitleList";
import { ImpactDialogActions } from "../../components/ImpactDialogActions";
import { summarizeDisposalImpacts } from "../impacts/impactSummary";

export function ImpactConfirmDialog({
  impacts,
  busy = false,
  onCancel,
  onConfirm,
  onSaveAll,
}: {
  impacts: WorkspaceContentDisposalImpact[];
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  /** 保存全部未保存的文件，成功后继续关闭（m6-108）。 */
  onSaveAll: () => void;
}) {
  const { t } = useTranslation();
  const summary = summarizeDisposalImpacts(impacts);
  const runningCount = summary.runningPtys.count;
  const dirtyFiles = summary.dirtyFiles;

  return (
    <div className="app-exit-overlay">
      <section className="app-exit-dialog" role="alertdialog" aria-modal="true">
        <h2>{t("workspaceFiles.confirmCloseTitle")}</h2>
        {runningCount > 0 && (
          <>
            <p>{t("pty.confirmCloseMany", { count: runningCount })}</p>
            <ImpactTitleList
              items={summary.runningPtys.titles.map((title) => ({
                key: `running:${title}`,
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
        <ImpactDialogActions
          hasUnsavedFiles={dirtyFiles.length > 0}
          busy={busy}
          labels={{
            cancel: t("common.cancel"),
            confirm: t("common.confirm"),
            saveAll: t("workspaceFiles.saveAllAndClose"),
            saveAllBusy: t("workspaceFiles.saveAllInProgress"),
            discard: t("workspaceFiles.discardAndClose"),
          }}
          onCancel={onCancel}
          onConfirm={onConfirm}
          onSaveAll={onSaveAll}
        />
      </section>
    </div>
  );
}

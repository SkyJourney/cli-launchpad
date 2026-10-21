export interface ImpactDialogActionsLabels {
  cancel: string;
  /** 没有未保存文件时的确认按钮（如只涉及运行中的会话）。 */
  confirm: string;
  /** 确认进行中（会话正在终止）时确认按钮的文字。 */
  confirmBusy?: string;
  /** 有未保存文件时的主按钮：保存全部后继续原动作。 */
  saveAll: string;
  /** 保存进行中时主按钮的文字。 */
  saveAllBusy: string;
  /** 有未保存文件时的危险按钮：放弃修改并继续原动作。 */
  discard: string;
}

export interface ImpactDialogActionsProps {
  /** 是否存在未保存的文件；存在时显示“保存全部”与“放弃”两个动作（m6-108）。 */
  hasUnsavedFiles: boolean;
  /** 保存或确认进行中：所有按钮禁用，按钮组布局不变。 */
  busy: boolean;
  /** 确认进行中（而非保存进行中）时使用 confirmBusy 文案。 */
  confirming?: boolean;
  labels: ImpactDialogActionsLabels;
  onCancel: () => void;
  onConfirm: () => void;
  onSaveAll: () => void;
}

/**
 * 退出与关闭内容两个确认对话框共用的按钮组（m6-108）。
 * 无未保存文件时只有“取消”与“确认”；有未保存文件时为“取消”、“保存全部”（主按钮）与“放弃”。
 */
export function ImpactDialogActions({
  hasUnsavedFiles,
  busy,
  confirming = false,
  labels,
  onCancel,
  onConfirm,
  onSaveAll,
}: ImpactDialogActionsProps) {
  return (
    <div className="app-exit-actions">
      <button className="ghost-button" disabled={busy} onClick={onCancel}>
        {labels.cancel}
      </button>
      {hasUnsavedFiles ? (
        <>
          <button className="ghost-button" disabled={busy} onClick={onConfirm}>
            {labels.discard}
          </button>
          <button
            className="primary-button"
            disabled={busy}
            onClick={onSaveAll}
          >
            {busy && !confirming ? labels.saveAllBusy : labels.saveAll}
          </button>
        </>
      ) : (
        <button className="primary-button" disabled={busy} onClick={onConfirm}>
          {busy && confirming && labels.confirmBusy
            ? labels.confirmBusy
            : labels.confirm}
        </button>
      )}
    </div>
  );
}

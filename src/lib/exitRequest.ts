export interface ExitRequestedPayload {
  requestId: string;
  ptyCount: number;
  executionTaskCount: number;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

// 只接受后端 app-exit-requested 的形状；不合格返回 null，调用方不得据此确认退出。
// executionTaskCount 缺失或非有限数按 0 处理（2026-10-11 裁定，对应 FE-U-2）。
export function parseExitRequestedPayload(
  raw: unknown,
): ExitRequestedPayload | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return null;
  const { requestId, ptyCount, executionTaskCount } = raw as Record<
    string,
    unknown
  >;
  if (typeof requestId !== "string" || requestId.trim() === "") return null;
  if (!isCount(ptyCount)) return null;
  if (
    typeof executionTaskCount === "number" &&
    Number.isFinite(executionTaskCount)
  ) {
    if (executionTaskCount < 0) return null;
    return { requestId, ptyCount, executionTaskCount };
  }
  return { requestId, ptyCount, executionTaskCount: 0 };
}

/** 主窗口上报给 Rust 的一个未保存文件（m6-101）。 */
export interface ReportedDirtyFile {
  documentId: string;
  relativePath: string;
}

/** Rust 重算并下发的退出影响；前端只显示它，不再自行计数（m6-101）。 */
export interface ExitImpactsView {
  requestId: string;
  ptyCount: number;
  executionTaskCount: number;
  dirtyFiles: ReportedDirtyFile[];
  requiresPrompt: boolean;
}

function isReportedDirtyFile(value: unknown): value is ReportedDirtyFile {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const { documentId, relativePath } = value as Record<string, unknown>;
  return typeof documentId === "string" && typeof relativePath === "string";
}

// 只接受 report_exit_impacts 的返回形状，且 requestId 必须是本次请求；不合格返回 null。
export function parseExitImpactsView(
  raw: unknown,
  requestId: string,
): ExitImpactsView | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return null;
  const view = raw as Record<string, unknown>;
  if (view.requestId !== requestId) return null;
  if (!isCount(view.ptyCount) || !isCount(view.executionTaskCount)) return null;
  if (typeof view.requiresPrompt !== "boolean") return null;
  if (!Array.isArray(view.dirtyFiles)) return null;
  if (!view.dirtyFiles.every(isReportedDirtyFile)) return null;
  return {
    requestId,
    ptyCount: view.ptyCount,
    executionTaskCount: view.executionTaskCount,
    dirtyFiles: view.dirtyFiles.map((file) => ({
      documentId: file.documentId,
      relativePath: file.relativePath,
    })),
    requiresPrompt: view.requiresPrompt,
  };
}

/** 确认前的核对（前端侧）：任一计数比对话框展示的更大，说明有新增的运行中工作。 */
export function exitCountsGrew(
  shown: { ptyCount: number; executionTaskCount: number },
  fresh: { ptyCount: number; executionTaskCount: number },
): boolean {
  return (
    fresh.ptyCount > shown.ptyCount ||
    fresh.executionTaskCount > shown.executionTaskCount
  );
}

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

import { useCallback, useRef, useState } from "react";
import type { WorkspaceContentDisposalImpact } from "../../lib/workspaceContentClose";

export interface CloseConfirmation {
  /** 等待用户确认的影响清单；null 表示没有进行中的确认。 */
  impacts: WorkspaceContentDisposalImpact[] | null;
  confirm: (impacts: WorkspaceContentDisposalImpact[]) => Promise<boolean>;
  resolve: (confirmed: boolean) => void;
}

/** 关闭确认对话框的状态与 resolver：同一时刻只允许一个进行中的确认。 */
export function useCloseConfirmation(): CloseConfirmation {
  const [impacts, setImpacts] = useState<
    WorkspaceContentDisposalImpact[] | null
  >(null);
  const resolverRef = useRef<((confirmed: boolean) => void) | null>(null);

  const confirm = useCallback(
    (nextImpacts: WorkspaceContentDisposalImpact[]) =>
      new Promise<boolean>((resolve) => {
        if (resolverRef.current) {
          resolve(false);
          return;
        }
        resolverRef.current = resolve;
        setImpacts(nextImpacts);
      }),
    [],
  );

  const resolve = useCallback((confirmed: boolean) => {
    const resolver = resolverRef.current;
    resolverRef.current = null;
    setImpacts(null);
    resolver?.(confirmed);
  }, []);

  return { impacts, confirm, resolve };
}

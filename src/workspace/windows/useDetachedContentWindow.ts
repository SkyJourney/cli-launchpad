import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
} from "react";
import {
  encodeWorkspaceContentDrag,
  WORKSPACE_CONTENT_DRAG_TYPE,
} from "../../lib/workspaceContentDrag";
import { fileContentKey, ptyContentKey } from "../../lib/workspaceContentKey";

export type DetachedContentKind = "pty" | "file";

export interface DetachedContentWindowKit {
  windowLabel: string;
  returning: boolean;
  isReturning: () => boolean;
  setReturning: (value: boolean) => void;
  error: string | null;
  setError: (value: string | null) => void;
  returnTimer: {
    arm: (ms: number, onTimeout: () => void) => void;
    clear: () => void;
  };
  destroyWindow: (description: string) => Promise<void>;
  createDragStartHandler: (
    isEnabled: () => boolean,
    extra?: (dataTransfer: DataTransfer) => void,
  ) => (event: ReactDragEvent<HTMLElement>) => void;
}

/** Logic that is identical in both detached content windows. */
export function useDetachedContentWindow(
  kind: DetachedContentKind,
  contentId: string,
): DetachedContentWindowKit {
  const windowLabel = useMemo(() => getCurrentWindow().label, []);
  const [returning, setReturningState] = useState(false);
  const returningRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  const setReturning = useCallback((value: boolean) => {
    returningRef.current = value;
    setReturningState(value);
  }, []);
  const isReturning = useCallback(() => returningRef.current, []);

  const clear = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);
  const arm = useCallback(
    (ms: number, onTimeout: () => void) => {
      clear();
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        onTimeout();
      }, ms);
    },
    [clear],
  );
  useEffect(() => clear, [clear]);

  const destroyWindow = useCallback(async (description: string) => {
    try {
      await getCurrentWindow().destroy();
    } catch (reason) {
      console.error(description, reason);
    }
  }, []);

  const createDragStartHandler = useCallback(
    (isEnabled: () => boolean, extra?: (dataTransfer: DataTransfer) => void) =>
      (event: ReactDragEvent<HTMLElement>) => {
        if (!isEnabled()) {
          event.preventDefault();
          return;
        }
        const payload = encodeWorkspaceContentDrag({
          key:
            kind === "pty"
              ? ptyContentKey(contentId)
              : fileContentKey(contentId),
          sourceWindowLabel: windowLabel,
        });
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(WORKSPACE_CONTENT_DRAG_TYPE, payload);
        extra?.(event.dataTransfer);
        event.dataTransfer.setData("text/plain", payload);
      },
    [kind, contentId, windowLabel],
  );

  return useMemo(
    () => ({
      windowLabel,
      returning,
      isReturning,
      setReturning,
      error,
      setError,
      returnTimer: { arm, clear },
      destroyWindow,
      createDragStartHandler,
    }),
    [
      windowLabel,
      returning,
      isReturning,
      setReturning,
      error,
      arm,
      clear,
      destroyWindow,
      createDragStartHandler,
    ],
  );
}

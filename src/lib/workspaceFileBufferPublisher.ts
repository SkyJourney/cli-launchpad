import type { WorkspaceContentWindowEventPayloads } from "./workspaceContentWindowProtocol";

export type WorkspaceFileBufferChange =
  WorkspaceContentWindowEventPayloads["workspace-file-window-buffer-changed"];

export function createWorkspaceFileBufferPublisher(
  publish: (payload: WorkspaceFileBufferChange) => Promise<void>,
  delayMs = 150,
) {
  let pending: WorkspaceFileBufferChange | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = Promise.resolve();

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const flush = (): Promise<void> => {
    clearTimer();
    if (!pending) return inFlight;
    const latest = pending;
    pending = null;
    inFlight = inFlight.catch(() => undefined).then(() => publish(latest));
    return inFlight;
  };

  return {
    publishLatest(payload: WorkspaceFileBufferChange) {
      pending = payload;
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        void flush().catch((reason) =>
          console.error("Unable to publish workspace file buffer", reason),
        );
      }, delayMs);
    },
    flush,
    dispose() {
      clearTimer();
      pending = null;
    },
  };
}

export type HostResetReason = "hydrate" | "rehydrate";

export interface HostRuntimeSteps {
  /** 1. Fail and settle pending detach/return operations; destroy their windows. */
  rollbackPending: () => void;
  /** 2. Forget window handles. Never destroys an attached window. */
  forgetWindowHandles: () => void;
  /** 3. Release editor models of documents that disappear and invalidate loads. */
  releaseDocuments: () => void;
  /** 4. Discard live PTY runtime handles (terminal handles). */
  clearPtyRuntime: () => void;
  /** 5. Rebuild the content coordinator for the next layout. */
  rebuildCoordinator: () => void;
}

export const HOST_RESET_STEP_ORDER = [
  "rollbackPending",
  "forgetWindowHandles",
  "releaseDocuments",
  "clearPtyRuntime",
  "rebuildCoordinator",
] as const satisfies readonly (keyof HostRuntimeSteps)[];

/**
 * Runs every reset step in the fixed order. A failing step is logged and does
 * not prevent later steps. Returns the names of the steps that ran.
 */
export function resetHostRuntime(
  reason: HostResetReason,
  steps: HostRuntimeSteps,
): readonly (keyof HostRuntimeSteps)[] {
  const ran: (keyof HostRuntimeSteps)[] = [];
  for (const name of HOST_RESET_STEP_ORDER) {
    ran.push(name);
    try {
      steps[name]();
    } catch (error) {
      console.error(
        `Workspace host reset step failed: ${name} (${reason})`,
        error,
      );
    }
  }
  return ran;
}

import {
  registerIsolated,
  type IsolatedRegistration,
  type IsolatedRegistrationFailure,
  type RetrySleep,
} from "./retryPolicy";

export type WorkspaceContentUnlisten = () => void;

/** 主窗口监听注册的默认重试间隔：共 3 次尝试，第 2、3 次之前分别等待 100 ms、300 ms。 */
export const LISTENER_REGISTRATION_RETRY_DELAYS_MS: readonly number[] = [
  100, 300,
];

/**
 * 逐项隔离地注册一组监听：单项失败只重试并报告该项，其余保持有效。
 * signal 中止后，已注册与晚到的注册都会被注销，返回的 cleanup 幂等。
 */
export async function setupWorkspaceContentListeners(args: {
  registrations: readonly IsolatedRegistration[];
  signal: AbortSignal;
  retryDelaysMs?: readonly number[];
  sleep?: RetrySleep;
  onFailed: (failed: IsolatedRegistrationFailure[]) => void;
}): Promise<WorkspaceContentUnlisten> {
  const delays = args.retryDelaysMs ?? LISTENER_REGISTRATION_RETRY_DELAYS_MS;
  const result = await registerIsolated({
    registrations: args.registrations,
    maxAttempts: delays.length + 1,
    delayMs: (retryIndex) =>
      delays[Math.min(retryIndex, delays.length - 1)] ?? 0,
    signal: args.signal,
    sleep: args.sleep,
  });
  if (result.failed.length > 0 && !args.signal.aborted) {
    args.onFailed(result.failed);
  }
  return result.cleanup;
}

/** 独立窗口里所有订阅共用一个底层协议监听，失败总是整体失败，所以不重试。 */
export class WorkspaceListenerSetupError extends Error {
  constructor(readonly failures: readonly unknown[]) {
    super(
      failures
        .map((reason) =>
          reason instanceof Error
            ? reason.message
            : typeof reason === "string"
              ? reason
              : String(reason),
        )
        .join("; "),
    );
    this.name = "WorkspaceListenerSetupError";
  }
}

/** 等待全部注册；只要有一项失败，就注销已成功的项并抛出 WorkspaceListenerSetupError。 */
export async function registerAllOrCleanup(
  registrations: ReadonlyArray<Promise<WorkspaceContentUnlisten>>,
): Promise<WorkspaceContentUnlisten[]> {
  const results = await Promise.allSettled(registrations);
  const unlisten = results.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length === 0) return unlisten;
  for (const stop of unlisten) {
    try {
      stop();
    } catch (error) {
      console.warn("Workspace content listener cleanup failed", error);
    }
  }
  throw new WorkspaceListenerSetupError(failures);
}

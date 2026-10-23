export interface ContributionFailure {
  registry: string;
  id: string;
  error: unknown;
}

const failures: ContributionFailure[] = [];

/**
 * 启动期注册一项贡献：被拒绝（抛出）时记录并返回空操作的注销函数，
 * 不影响其余贡献（统一规则 R2）。
 */
export function registerContributionSafely(
  registry: string,
  id: string,
  register: () => () => void,
): () => void {
  try {
    return register();
  } catch (error) {
    failures.push({ registry, id, error });
    console.error(`[bootstrap.contribution_rejected] ${registry}:${id}`, error);
    return () => {};
  }
}

export function getContributionFailures(): readonly ContributionFailure[] {
  return [...failures];
}

export function clearContributionFailures(): void {
  failures.length = 0;
}

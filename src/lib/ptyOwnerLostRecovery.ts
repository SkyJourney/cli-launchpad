import { exponentialDelay } from "./retryPolicy";

/** owner-lost 之后重新接管 PTY 会话的总尝试次数（含第一次）。 */
export const PTY_OWNER_LOST_MAX_ATTEMPTS = 8;

const ownerLostDelay = exponentialDelay({ baseMs: 500, capMs: 4000 });

/** 第 retryIndex（从 0 起）次重试之前的等待毫秒数：500、1000、2000、4000，之后恒为 4000。 */
export function ptyOwnerLostRetryDelay(retryIndex: number): number {
  return ownerLostDelay(retryIndex);
}

/** 一次重新接管尝试的结果；除 reattached 外都不再重试。 */
export type PtyOwnerLostAttemptResult =
  | { kind: "reattached" }
  | { kind: "ended" }
  | { kind: "foreign-owner" }
  | { kind: "slot-gone" };

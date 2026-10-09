export type PendingWindowKind = "pty" | "file";

/**
 * creating：窗口已创建，尚未收到子窗口 ready（只有文件窗经过）。
 * ready：已收到 ready，主窗口正在准备 init 载荷（只有文件窗经过）。
 * initSent：init 已发出，或载荷已随窗口创建交付（终端窗的初始阶段）。
 * attached：子窗口已确认接管，记录随后被提升出 pending 表。
 */
export type PendingWindowStage = "creating" | "ready" | "initSent" | "attached";

/** windowReady：子窗口 ready；initSent：主窗口发出 init；attachedAck：子窗口确认接管。 */
export type PendingWindowEvent = "windowReady" | "initSent" | "attachedAck";

export type PendingStageRejection =
  | "duplicate"
  | "out-of-order"
  | "not-applicable"
  | "already-attached";

export type PendingStageTransition =
  | { accepted: true; stage: PendingWindowStage }
  | { accepted: false; reason: PendingStageRejection };

export function initialPendingStage(
  kind: PendingWindowKind,
): PendingWindowStage {
  return kind === "pty" ? "initSent" : "creating";
}

const accept = (stage: PendingWindowStage): PendingStageTransition => ({
  accepted: true,
  stage,
});
const reject = (reason: PendingStageRejection): PendingStageTransition => ({
  accepted: false,
  reason,
});

export function reducePendingStage(
  kind: PendingWindowKind,
  stage: PendingWindowStage,
  event: PendingWindowEvent,
): PendingStageTransition {
  if (stage === "attached") return reject("already-attached");

  if (kind === "pty") {
    if (event !== "attachedAck") return reject("not-applicable");
    return stage === "initSent" ? accept("attached") : reject("out-of-order");
  }

  switch (event) {
    case "windowReady":
      return stage === "creating" ? accept("ready") : reject("duplicate");
    case "initSent":
      if (stage === "ready") return accept("initSent");
      return stage === "creating"
        ? reject("out-of-order")
        : reject("duplicate");
    case "attachedAck":
      return stage === "initSent" ? accept("attached") : reject("out-of-order");
  }
}

/** 唯一允许修改 stage 的入口：被接受时就地推进并返回 true，被拒绝时不改记录并返回 false。 */
export function advancePendingWindowStage(
  record: { kind: PendingWindowKind; stage: PendingWindowStage },
  event: PendingWindowEvent,
): boolean {
  const transition = reducePendingStage(record.kind, record.stage, event);
  if (!transition.accepted) return false;
  record.stage = transition.stage;
  return true;
}

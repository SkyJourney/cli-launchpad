import type { WindowInboxSource } from "./tauri";
import { sendWindowMessage } from "./windowMessages";

export const VERSION_MISMATCH_MESSAGE = "protocol.version_mismatch";

interface VersionMismatchReply {
  /** 回送给发送方的失败消息类型（必须在 window-messages.json 里登记）。 */
  type: string;
  /** 从收到的（不可信）载荷构造失败载荷；缺少必要字段时返回 null（只告警，不回送）。 */
  build(
    payload: Record<string, unknown>,
    currentWindowLabel: string,
  ): Record<string, unknown> | null;
}

function contentIds(
  payload: Record<string, unknown>,
): { content: { kind: string; id: string }; transferId: string } | null {
  const content = payload.content;
  if (typeof content !== "object" || content === null || Array.isArray(content))
    return null;
  const { kind, id } = content as Record<string, unknown>;
  if (
    (kind !== "pty" && kind !== "file") ||
    typeof id !== "string" ||
    id.trim() === ""
  )
    return null;
  if (
    typeof payload.transferId !== "string" ||
    payload.transferId.trim() === ""
  )
    return null;
  return { content: { kind, id }, transferId: payload.transferId };
}

/**
 * 每个窗口消息类型一项：有失败对应物的请求回送失败消息，其余只告警（null）。
 * windowProtocolVersion.test.ts 的 WV-8 保证键集合等于 contracts/window-messages.json，
 * 回送方向成立，且失败消息自身的项为 null（不会产生回送环）。
 */
export const VERSION_MISMATCH_REPLIES: Readonly<
  Record<string, VersionMismatchReply | null>
> = {
  "app-preferences-reply": null,
  "app-preferences-requested": null,
  "content-handoff-attached": null,
  "content-handoff-exited": null,
  "content-handoff-failed": null,
  "content-handoff-flush-complete": null,
  "content-handoff-flush-requested": null,
  "content-handoff-init": {
    type: "content-handoff-failed",
    build: (payload, currentWindowLabel) => {
      const ids = contentIds(payload);
      return (
        ids && {
          ...ids,
          payload: {
            windowLabel: currentWindowLabel,
            message: VERSION_MISMATCH_MESSAGE,
          },
        }
      );
    },
  },
  "content-handoff-ready": null,
  "content-handoff-return-complete": null,
  "content-handoff-return-drop-requested": null,
  "content-handoff-return-failed": null,
  "content-handoff-return-requested": {
    type: "content-handoff-return-failed",
    build: (payload) => {
      const ids = contentIds(payload);
      return ids && { ...ids, payload: { message: VERSION_MISMATCH_MESSAGE } };
    },
  },
  "content-handoff-state-changed": null,
};

const handledSeq: number[] = [];

export function resetVersionMismatchStateForTests(): void {
  handledSeq.length = 0;
}

function firstTime(seq: number): boolean {
  if (handledSeq.includes(seq)) return false;
  handledSeq.push(seq);
  if (handledSeq.length > 64) handledSeq.shift();
  return true;
}

export interface VersionMismatch {
  type: string;
  expected: number;
  received: unknown;
  source: WindowInboxSource;
  seq: number;
  payload: unknown;
  currentWindowLabel: string;
}

/** 线协议版本不一致：告警，必要时向发送方回送失败消息；同一个 seq 只处理一次。 */
export async function handleVersionMismatch(
  mismatch: VersionMismatch,
): Promise<void> {
  if (!firstTime(mismatch.seq)) return;
  console.warn(
    `[protocol.version_mismatch] ${mismatch.type}: 期望 ${mismatch.expected}，收到 ${String(mismatch.received)}，来自 ${mismatch.source.label}`,
  );
  const reply = VERSION_MISMATCH_REPLIES[mismatch.type];
  if (!reply) return;
  const raw =
    typeof mismatch.payload === "object" &&
    mismatch.payload !== null &&
    !Array.isArray(mismatch.payload)
      ? (mismatch.payload as Record<string, unknown>)
      : {};
  const payload = reply.build(raw, mismatch.currentWindowLabel);
  if (!payload) {
    console.warn(
      `[protocol.version_mismatch_unanswered] ${mismatch.type}: 载荷缺少回送所需字段`,
    );
    return;
  }
  try {
    const delivered = await sendWindowMessage(
      mismatch.source.label,
      reply.type,
      payload,
    );
    if (!delivered) {
      console.warn(
        `[protocol.version_mismatch_unanswered] ${mismatch.type}: 发送方窗口不可达`,
      );
    }
  } catch (error) {
    console.warn(
      `[protocol.version_mismatch_unanswered] ${mismatch.type}`,
      error,
    );
  }
}

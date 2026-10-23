// 仅测试夹具：把目标 091 之前既有宿主测试使用的旧消息名翻译为泛型信封，生产代码不得导入本文件。
import {
  contentHandoffMessageType,
  decodeContentHandoff,
  encodeContentHandoff,
  type ContentHandoffKind,
  type ContentHandoffWirePayload,
} from "../../lib/workspaceContentWindowProtocol";

export const LEGACY_HANDOFF_NAMES = {
  "pty-detached-ready": ["pty", "ready"],
  "pty-detached-failed": ["pty", "failed"],
  "pty-detached-exited": ["pty", "exited"],
  "pty-return-requested": ["pty", "return-requested"],
  "pty-return-complete": ["pty", "return-complete"],
  "pty-return-failed": ["pty", "return-failed"],
  "pty-return-drop-requested": ["pty", "return-drop-requested"],
  "workspace-file-window-ready": ["file", "ready"],
  "workspace-file-window-init": ["file", "init"],
  "workspace-file-window-attached": ["file", "attached"],
  "workspace-file-window-attach-failed": ["file", "failed"],
  "workspace-file-window-buffer-changed": ["file", "state-changed"],
  "workspace-file-window-flush-requested": ["file", "flush-requested"],
  "workspace-file-window-flush-complete": ["file", "flush-complete"],
  "workspace-file-window-return-requested": ["file", "return-requested"],
  "workspace-file-window-return-complete": ["file", "return-complete"],
  "workspace-file-window-return-failed": ["file", "return-failed"],
  "workspace-file-window-return-drop-requested": [
    "file",
    "return-drop-requested",
  ],
} as const satisfies Record<string, readonly [ContentHandoffKind, string]>;

export type LegacyHandoffName = keyof typeof LEGACY_HANDOFF_NAMES;

export function toGenericMessage(
  legacyType: LegacyHandoffName,
  legacyPayload: unknown,
): { type: string; payload: ContentHandoffWirePayload } {
  const [kind, phase] = LEGACY_HANDOFF_NAMES[legacyType];
  return {
    type: contentHandoffMessageType(phase),
    payload: encodeContentHandoff(
      kind,
      legacyPayload as Record<string, unknown>,
    ),
  };
}

export function fromGenericMessage(
  wireType: string,
  wirePayload: unknown,
): {
  legacyType: LegacyHandoffName;
  kind: ContentHandoffKind;
  phase: string;
  payload: Record<string, unknown>;
} | null {
  const kind = (wirePayload as { content?: { kind?: unknown } } | null)?.content
    ?.kind;
  if (kind !== "pty" && kind !== "file") return null;
  const entry = (
    Object.entries(LEGACY_HANDOFF_NAMES) as [
      LegacyHandoffName,
      readonly [ContentHandoffKind, string],
    ][]
  ).find(
    ([, [entryKind, phase]]) =>
      entryKind === kind && contentHandoffMessageType(phase) === wireType,
  );
  if (!entry) return null;
  const payload = decodeContentHandoff(kind, wirePayload);
  if (payload === null) return null;
  return { legacyType: entry[0], kind, phase: entry[1][1], payload };
}

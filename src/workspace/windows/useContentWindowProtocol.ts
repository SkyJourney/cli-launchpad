import { useEffect } from "react";
import type { ProtocolListenerShell } from "./contentWindowOrchestrator";
import type { FileProtocolHandlers } from "./protocolHandlers.file";
import {
  startFileListeners,
  startWindowLostListeners,
} from "./protocolHandlers.file";
import type { PtyProtocolHandlers } from "./protocolHandlers.pty";
import { startPtyListeners } from "./protocolHandlers.pty";

export interface ContentWindowProtocol {
  /** 注册三组窗口协议监听；返回一个统一的清理函数。 */
  start(): () => void;
}

/** 唯一注册独立窗口协议监听的 effect：依赖只有稳定的 protocol 对象。 */
export function useContentWindowProtocol(
  protocol: ContentWindowProtocol,
): void {
  useEffect(() => protocol.start(), [protocol]);
}

export function createContentWindowProtocol(args: {
  pty: PtyProtocolHandlers;
  file: FileProtocolHandlers;
  shell: ProtocolListenerShell;
}): ContentWindowProtocol {
  return {
    start() {
      const stops = [
        startPtyListeners(args.pty, args.shell),
        startWindowLostListeners(args.file, args.shell),
        startFileListeners(args.file, args.shell),
      ];
      return () => stops.forEach((stop) => stop());
    },
  };
}

import { invoke } from "@tauri-apps/api/core";
import type { AppCommand } from "../generated/appCommands";

/** 前端调用 Tauri 命令的唯一入口：命令名必须是契约里的 AppCommand（拼错在编译期失败）。 */
export function invokeApp<T = void>(
  command: AppCommand,
  args?: Record<string, unknown>,
): Promise<T> {
  return invoke<T>(command, args);
}

// 由 scripts/gen-contracts.mjs 生成，请勿手改。来源：contracts/window-kinds.json（非主窗口路由）
import type { ComponentType } from "react";
import type { WindowShellProps } from "../components/windowShells/types";
import terminalShell from "../components/windowShells/terminal";
import workspaceContentShell from "../components/windowShells/workspace-content";

export const WINDOW_SHELLS: Record<"terminal" | "workspace-content", ComponentType<WindowShellProps>> = {
  "terminal": terminalShell,
  "workspace-content": workspaceContentShell,
};

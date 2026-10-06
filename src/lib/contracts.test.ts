import appCommands from "../../contracts/app-commands.json";
import contentKinds from "../../contracts/content-kinds.json";
import toolKeys from "../../contracts/tool-keys.json";
import windowKinds from "../../contracts/window-kinds.json";
import { describe, expect, it } from "vitest";
import { TOOLS } from "./tools";
import type { ToolKey, WorkspacePaneContentRef } from "./tauri";
import { getWorkspaceContentWindowLabelPrefix } from "./workspaceContentWindowProtocol";
import {
  createWindowLabel,
  isDetachedWindowLabel,
  windowKindOf,
  windowRouteOf,
} from "./windowKinds";

const toolKeyTypeCoverage: Record<ToolKey, true> = {
  claude: true,
  codex: true,
  antigravity: true,
  grok: true,
  hermes: true,
};

const contentKindTypeCoverage: Record<WorkspacePaneContentRef["kind"], true> = {
  pty: true,
  file: true,
};

describe("shared contracts", () => {
  it("matches the TypeScript CLI registry and union", () => {
    expect(TOOLS.map((tool) => tool.key)).toEqual(toolKeys);
    expect(Object.keys(toolKeyTypeCoverage)).toEqual(toolKeys);
  });

  it("matches the TypeScript workspace content kinds", () => {
    expect(Object.keys(contentKindTypeCoverage)).toEqual(contentKinds);
  });

  it("declares each current window kind and registered app command", () => {
    expect(windowKinds.version).toBe(1);
    expect(windowKinds.kinds.map((kind) => kind.id)).toEqual([
      "main",
      "terminal",
      "workspaceContent",
    ]);
    expect(appCommands.length).toBeGreaterThan(0);
    expect(new Set(appCommands).size).toBe(appCommands.length);

    const terminalWindow = windowKinds.kinds.find(
      (kind) => kind.id === "terminal",
    );
    const workspaceContentWindow = windowKinds.kinds.find(
      (kind) => kind.id === "workspaceContent",
    );
    expect(terminalWindow?.labelPrefix).toBe(
      getWorkspaceContentWindowLabelPrefix("pty"),
    );
    expect(workspaceContentWindow?.labelPrefix).toBe(
      getWorkspaceContentWindowLabelPrefix("file"),
    );
  });

  it("uses the shared window registry for labels and routing", () => {
    const terminal = createWindowLabel("terminal");
    const workspaceContent = createWindowLabel("workspaceContent");

    expect(windowKindOf("main")).toBe("main");
    expect(windowKindOf(terminal)).toBe("terminal");
    expect(windowKindOf(workspaceContent)).toBe("workspaceContent");
    expect(windowKindOf("terminal-invalid")).toBeNull();
    expect(isDetachedWindowLabel("main")).toBe(false);
    expect(isDetachedWindowLabel(terminal)).toBe(true);
    expect(isDetachedWindowLabel(workspaceContent)).toBe(true);
    expect(windowRouteOf(terminal)).toBe("terminal");
    expect(windowRouteOf(workspaceContent)).toBe("workspace-content");
  });
});

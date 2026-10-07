import appCommands from "../../contracts/app-commands.json";
import contentKinds from "../../contracts/content-kinds.json";
import toolKeys from "../../contracts/tool-keys.json";
import windowKinds from "../../contracts/window-kinds.json";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerBuiltinContributions } from "../bootstrap/registerBuiltinContributions";
import {
  getWorkspaceContentAdapter,
  registerWorkspaceContentAdapter,
} from "../components/workspaceContentAdapterRegistry";
import { TOOLS } from "./tools";
import type { ToolKey, WorkspacePaneContentRef } from "./tauri";
import {
  encodeWorkspaceContentDrag,
  parseWorkspaceContentDrag,
} from "./workspaceContentDrag";
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
  unknown: true,
};

describe("shared contracts", () => {
  let unregisterContributions: (() => void) | undefined;
  beforeEach(() => {
    unregisterContributions = registerBuiltinContributions();
  });
  afterEach(() => {
    unregisterContributions?.();
    unregisterContributions = undefined;
  });

  it("matches the TypeScript CLI registry and union", () => {
    expect(TOOLS.map((tool) => tool.key)).toEqual(toolKeys);
    expect(Object.keys(toolKeyTypeCoverage)).toEqual(toolKeys);
  });

  it("matches the TypeScript workspace content kinds", () => {
    expect(contentKinds.adapterApiVersion).toBe(2);
    expect(
      Object.keys(contentKindTypeCoverage).filter((kind) => kind !== "unknown"),
    ).toEqual(contentKinds.kinds);
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
    expect(terminalWindow?.labelPrefix).toBe("terminal-");
    expect(workspaceContentWindow?.labelPrefix).toBe("workspace-content-");
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

  it("keeps built-in adapter kinds and API versions in the content-kind contract", () => {
    expect(contentKinds.kinds).toEqual(["pty", "file"]);
    for (const kind of contentKinds.kinds) {
      expect(
        getWorkspaceContentAdapter(kind as "pty" | "file").apiVersion,
      ).toBe(contentKinds.adapterApiVersion);
    }
    expect(() =>
      registerWorkspaceContentAdapter({
        id: "contract-test.markdown",
        apiVersion: contentKinds.adapterApiVersion + 1,
        kind: "markdownPreview",
      } as never),
    ).toThrow(
      `不支持内容适配器 API 版本: ${contentKinds.adapterApiVersion + 1}`,
    );
  });

  it("accepts drag payloads exactly for the contract kinds", () => {
    for (const kind of contentKinds.kinds) {
      const raw = encodeWorkspaceContentDrag({
        kind,
        contentId: "x",
        sourcePaneId: "p",
        sourceWindowLabel: "main",
      } as never);
      expect(parseWorkspaceContentDrag(raw)?.kind).toBe(kind);
    }
    expect(
      parseWorkspaceContentDrag(
        encodeWorkspaceContentDrag({
          kind: "markdownPreview",
          contentId: "x",
          sourcePaneId: "p",
          sourceWindowLabel: "main",
        } as never),
      ),
    ).toBeNull();
  });
});

/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import windowKinds from "../../contracts/window-kinds.json";
import defaultCapability from "../../src-tauri/capabilities/default.json";
import terminalCapability from "../../src-tauri/capabilities/terminal-window.json";
import workspaceContentCapability from "../../src-tauri/capabilities/workspace-content-window.json";
import { projectSources } from "../test/sourceClosure";
import { CORE_DEFAULT_IMPLIES } from "../test/tauriMock";
import {
  closureOfWindowKind,
  MAIN_ONLY_MODULES,
  type WindowKindId,
} from "../test/windowClosures";

type Capability = { permissions: Array<string | { identifier: string }> };
// 只豁免“该文件对该权限规则的命中”，不是整文件排除。
// createWorkspaceContentWindow（内含 new WebviewWindow）只由 PtyWorkspace.tsx 调用，
// 子窗口只使用同文件的 prepare/attach/rollback 三个函数。
const MAIN_ONLY_USES = [
  {
    path: "src/components/workspaceContentHandoffRuntime.ts",
    permission: "core:webview:allow-create-webview-window",
    guardIdentifier: "createWorkspaceContentWindow",
  },
] as const;

const CAPABILITIES: Record<WindowKindId, Capability> = {
  main: defaultCapability,
  terminal: terminalCapability,
  workspaceContent: workspaceContentCapability,
};

const apiPermissionRequirements: Array<{
  pattern: RegExp;
  permissions: string[];
  permissionPrefixes?: string[];
}> = [
  {
    pattern: /\b(?:listen|onCloseRequested)\s*(?:<[^>]*>)?\s*\(/,
    permissions: ["core:event:allow-listen", "core:event:allow-unlisten"],
  },
  {
    pattern: /\.once\s*\(/,
    permissions: ["core:event:allow-listen", "core:event:allow-unlisten"],
  },
  {
    pattern:
      /\.on(?:Resized|Moved|CloseRequested|ThemeChanged|FocusChanged)\s*\(/,
    permissions: ["core:event:allow-listen", "core:event:allow-unlisten"],
  },
  {
    pattern: /\bemitTo\s*(?:<[^>]*>)?\s*\(/,
    permissions: ["core:event:allow-emit-to"],
  },
  {
    pattern: /\bemit\s*(?:<[^>]*>)?\s*\(/,
    permissions: ["core:event:allow-emit"],
  },
  { pattern: /\.setTheme\s*\(/, permissions: ["core:window:allow-set-theme"] },
  { pattern: /\.setFocus\s*\(/, permissions: ["core:window:allow-set-focus"] },
  { pattern: /\.close\s*\(/, permissions: ["core:window:allow-close"] },
  { pattern: /\.destroy\s*\(/, permissions: ["core:window:allow-destroy"] },
  {
    pattern: /\.isMaximized\s*\(/,
    permissions: ["core:window:allow-is-maximized"],
  },
  { pattern: /\.minimize\s*\(/, permissions: ["core:window:allow-minimize"] },
  {
    pattern: /\.toggleMaximize\s*\(/,
    permissions: ["core:window:allow-toggle-maximize"],
  },
  {
    pattern: /\.startDragging\s*\(/,
    permissions: ["core:window:allow-start-dragging"],
  },
  {
    pattern: /\.startResizeDragging\s*\(/,
    permissions: ["core:window:allow-start-resize-dragging"],
  },
  {
    pattern: /\bnew\s+WebviewWindow\s*\(/,
    permissions: ["core:webview:allow-create-webview-window"],
  },
  {
    pattern: /WebviewWindow\.getByLabel\(/,
    permissions: ["core:webview:allow-get-all-webviews"],
  },
  {
    pattern: /from ["']@tauri-apps\/plugin-clipboard-manager["']/,
    permissions: [
      "clipboard-manager:allow-read-text",
      "clipboard-manager:allow-write-text",
    ],
  },
  {
    pattern: /from ["']@tauri-apps\/plugin-dialog["']/,
    permissions: [],
    permissionPrefixes: ["dialog:"],
  },
  {
    pattern: /from ["']@tauri-apps\/plugin-opener["']/,
    permissions: [],
    permissionPrefixes: ["opener:"],
  },
];

function expandPermissions(capability: Capability): Set<string> {
  const granted = new Set<string>();
  for (const entry of capability.permissions) {
    const identifier = typeof entry === "string" ? entry : entry.identifier;
    granted.add(identifier);
    if (identifier === "core:default") {
      for (const implied of CORE_DEFAULT_IMPLIES) granted.add(implied);
    }
  }
  return granted;
}

function without(capability: Capability, ...identifiers: string[]): Capability {
  return {
    permissions: capability.permissions.filter((entry) => {
      const identifier = typeof entry === "string" ? entry : entry.identifier;
      return !identifiers.includes(identifier);
    }),
  };
}

function findMissingPermissions(
  kindId: WindowKindId,
  capability: Capability,
): string[] {
  const closure = closureOfWindowKind(kindId);
  const granted = expandPermissions(capability);
  const missing = new Set<string>();
  for (const rule of apiPermissionRequirements) {
    const exempt: string[] =
      kindId === "main"
        ? []
        : MAIN_ONLY_USES.filter((use) =>
            rule.permissions.includes(use.permission),
          ).map((use) => use.path);
    const text = closure
      .filter((path) => !exempt.includes(path))
      .map((path) => projectSources[path])
      .join("\n");
    if (!rule.pattern.test(text)) continue;
    for (const permission of rule.permissions) {
      if (!granted.has(permission)) missing.add(permission);
    }
    for (const prefix of rule.permissionPrefixes ?? []) {
      if (![...granted].some((permission) => permission.startsWith(prefix))) {
        missing.add(`${prefix}*`);
      }
    }
  }
  return [...missing].sort();
}

describe("native API permissions by window kind", () => {
  it.each(windowKinds.kinds)("grants APIs used by $id", (kind) => {
    const kindId = kind.id as WindowKindId;

    expect(findMissingPermissions(kindId, CAPABILITIES[kindId])).toEqual([]);
  });

  it("scans every module in each window kind's import closure", () => {
    const main = closureOfWindowKind("main");
    const terminal = closureOfWindowKind("terminal");
    const workspaceContent = closureOfWindowKind("workspaceContent");

    expect(terminal).toEqual(
      expect.arrayContaining([
        "src/lib/workspaceContentWindowProtocol.ts",
        "src/lib/appPreferencesChild.ts",
        "src/components/PtyTerminal.tsx",
      ]),
    );
    expect(workspaceContent).toContain(
      "src/lib/workspaceContentWindowProtocol.ts",
    );
    expect(main).toContain("src/hooks/useExecutionTasks.ts");
    for (const id of ["main", "terminal", "workspaceContent"] as const) {
      expect(() => closureOfWindowKind(id)).not.toThrow();
    }
    expect(terminal).not.toContain("src/lib/appPreferencesMain.ts");
    expect(workspaceContent).not.toContain("src/lib/appPreferencesMain.ts");
    expect(main).toContain("src/lib/appPreferencesMain.ts");
    expect(main.length).toBeGreaterThanOrEqual(80);
    expect(terminal.length).toBeGreaterThanOrEqual(30);
    expect(workspaceContent.length).toBeGreaterThanOrEqual(25);
  });

  it.each([
    ["terminal", "core:event:allow-emit-to"],
    ["workspaceContent", "core:event:allow-emit-to"],
    ["main", "core:window:allow-set-focus"],
  ] as const)("reports %s when %s is removed", (kindId, permission) => {
    expect(findMissingPermissions(kindId, CAPABILITIES[kindId])).toEqual([]);

    expect(
      findMissingPermissions(kindId, without(CAPABILITIES[kindId], permission)),
    ).toContain(permission);
  });

  it("reports main when every dialog: permission is removed", () => {
    expect(findMissingPermissions("main", defaultCapability)).toEqual([]);

    expect(
      findMissingPermissions(
        "main",
        without(defaultCapability, "dialog:allow-open", "dialog:allow-save"),
      ),
    ).toContain("dialog:*");
    expect(
      findMissingPermissions(
        "main",
        without(defaultCapability, "dialog:allow-open"),
      ),
    ).not.toContain("dialog:*");
  });

  it("reports main when the opener permission is removed", () => {
    expect(findMissingPermissions("main", defaultCapability)).not.toContain(
      "opener:*",
    );

    expect(
      findMissingPermissions(
        "main",
        without(defaultCapability, "opener:allow-open-url"),
      ),
    ).toContain("opener:*");
  });

  it("reports terminal when the clipboard permissions are removed", () => {
    expect(
      findMissingPermissions(
        "terminal",
        without(
          terminalCapability,
          "clipboard-manager:allow-read-text",
          "clipboard-manager:allow-write-text",
        ),
      ),
    ).toEqual(
      expect.arrayContaining([
        "clipboard-manager:allow-read-text",
        "clipboard-manager:allow-write-text",
      ]),
    );

    const onlyRead = findMissingPermissions(
      "terminal",
      without(terminalCapability, "clipboard-manager:allow-read-text"),
    );
    expect(onlyRead).toContain("clipboard-manager:allow-read-text");
    expect(onlyRead).not.toContain("clipboard-manager:allow-write-text");
  });

  it("keeps the main-only exemptions narrow and live", () => {
    const terminal = closureOfWindowKind("terminal");
    const workspaceContent = closureOfWindowKind("workspaceContent");
    const main = closureOfWindowKind("main");

    for (const use of MAIN_ONLY_USES) {
      expect(terminal).toContain(use.path);
      expect(workspaceContent).toContain(use.path);
      const useSource = projectSources[use.path];
      expect(useSource.match(/\bnew\s+WebviewWindow\s*\(/g)).toHaveLength(1);
      // 豁免是整文件的，所以该文件唯一的 new WebviewWindow 必须在守卫函数体内；
      // 否则其他函数里新增的创建窗口调用会被这条豁免掩盖。
      const functionStart = useSource.indexOf(
        `function ${use.guardIdentifier}`,
      );
      expect(functionStart).toBeGreaterThanOrEqual(0);
      const functionEnd =
        functionStart + useSource.slice(functionStart).search(/\r?\n\}\r?\n/);
      const creation = useSource.search(/\bnew\s+WebviewWindow\s*\(/);
      expect(creation).toBeGreaterThan(functionStart);
      expect(creation).toBeLessThan(functionEnd);
      const guard = new RegExp(`\\b${use.guardIdentifier}\\b`);
      for (const closure of [terminal, workspaceContent]) {
        for (const path of closure.filter((entry) => entry !== use.path)) {
          expect(projectSources[path]).not.toMatch(guard);
        }
      }
      expect(projectSources["src/components/PtyWorkspace.tsx"]).toContain(
        use.guardIdentifier,
      );
      expect(main).toContain("src/components/PtyWorkspace.tsx");
    }
    for (const path of MAIN_ONLY_MODULES) {
      expect(main).toContain(path);
      expect(terminal).not.toContain(path);
      expect(workspaceContent).not.toContain(path);
    }
    expect(projectSources["src/hooks/useThemeSync.ts"]).toContain(
      'currentWindowLabel === "main"',
    );
    expect(projectSources["src/hooks/useThemeSync.ts"]).toContain(
      "appPreferencesMain",
    );
  });
});

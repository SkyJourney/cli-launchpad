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

type PermissionEntry = string | { identifier: string; [key: string]: unknown };

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function permissionIdentifier(entry: PermissionEntry): string {
  return typeof entry === "string" ? entry : entry.identifier;
}

// 与 src-tauri/src/contracts/mod.rs 的 capability_contract_violations 对插件权限的判定一致。
function pluginPermissionViolations(
  kindId: WindowKindId,
  capability: { permissions: PermissionEntry[] },
): string[] {
  const violations: string[] = [];
  const declaredEntries = windowKinds.kinds.find((kind) => kind.id === kindId)!
    .pluginPermissions as PermissionEntry[];
  const declared = declaredEntries.map(canonicalJson);
  const actual: PermissionEntry[] = [];
  for (const entry of capability.permissions) {
    const identifier = permissionIdentifier(entry);
    for (const forbidden of ["fs:", "shell:", "http:"]) {
      if (identifier.startsWith(forbidden)) {
        violations.push(`forbidden permission namespace: ${identifier}`);
      }
    }
    if (
      identifier.endsWith(":default") &&
      !(kindId === "main" && identifier === "core:default")
    ) {
      violations.push(`default permission set is not allowed: ${identifier}`);
    }
    const isPlugin =
      typeof entry !== "string" ||
      !(identifier.startsWith("allow-") || identifier.startsWith("core:"));
    if (isPlugin) actual.push(entry);
  }
  const actualCanonical = actual.map(canonicalJson);
  declaredEntries.forEach((entry, index) => {
    if (!actualCanonical.includes(declared[index])) {
      violations.push(
        `plugin permission missing or changed: ${permissionIdentifier(entry)}`,
      );
    }
  });
  actual.forEach((entry, index) => {
    if (!declared.includes(actualCanonical[index])) {
      violations.push(
        `plugin permission not declared in contract: ${permissionIdentifier(entry)}`,
      );
    }
  });
  return violations;
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

  it.each(windowKinds.kinds)(
    "matches the plugin permissions declared in window-kinds.json for $id",
    (kind) => {
      const kindId = kind.id as WindowKindId;

      expect(
        pluginPermissionViolations(
          kindId,
          CAPABILITIES[kindId] as { permissions: PermissionEntry[] },
        ),
      ).toEqual([]);
    },
  );

  it("reports undeclared, altered and forbidden plugin permissions", () => {
    const terminal = terminalCapability as { permissions: PermissionEntry[] };
    const main = defaultCapability as { permissions: PermissionEntry[] };
    const withAdded = (
      base: { permissions: PermissionEntry[] },
      added: PermissionEntry,
    ) => ({ permissions: [...base.permissions, added] });

    expect(pluginPermissionViolations("terminal", terminal)).toEqual([]);
    expect(pluginPermissionViolations("main", main)).toEqual([]);

    expect(
      pluginPermissionViolations("terminal", withAdded(terminal, "fs:default")),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("fs:default"),
        "plugin permission not declared in contract: fs:default",
      ]),
    );
    expect(
      pluginPermissionViolations(
        "terminal",
        withAdded(terminal, {
          identifier: "shell:allow-execute",
          allow: [{ name: "x" }],
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        "forbidden permission namespace: shell:allow-execute",
      ]),
    );
    expect(
      pluginPermissionViolations("main", {
        permissions: main.permissions.map((entry) =>
          typeof entry !== "string" &&
          entry.identifier === "opener:allow-open-url"
            ? {
                identifier: entry.identifier,
                allow: [{ url: "https://example.com" }],
              }
            : entry,
        ),
      }),
    ).toEqual(
      expect.arrayContaining([
        "plugin permission missing or changed: opener:allow-open-url",
        "plugin permission not declared in contract: opener:allow-open-url",
      ]),
    );
    expect(
      pluginPermissionViolations("terminal", {
        permissions: terminal.permissions.filter(
          (entry) => entry !== "clipboard-manager:allow-read-text",
        ),
      }),
    ).toEqual([
      "plugin permission missing or changed: clipboard-manager:allow-read-text",
    ]);
  });
});

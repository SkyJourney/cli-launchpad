/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import windowKinds from "../../contracts/window-kinds.json";
import defaultCapability from "../../src-tauri/capabilities/default.json";
import terminalCapability from "../../src-tauri/capabilities/terminal-window.json";
import workspaceContentCapability from "../../src-tauri/capabilities/workspace-content-window.json";

const sourcesByWindowKind: Record<string, string[]> = {
  main: [
    "../App.tsx",
    "../components/PtyWorkspace.tsx",
    "../components/PtyTerminal.tsx",
    "../components/WindowTitlebar.tsx",
    "../hooks/useThemeSync.ts",
    "../lib/appPreferencesMain.ts",
    "../lib/workspaceContentWindowProtocol.ts",
  ],
  terminal: [
    "../components/StandalonePtyWindow.tsx",
    "../components/PtyTerminal.tsx",
    "../components/WorkspaceContentWindowShell.tsx",
    "../components/WindowTitlebar.tsx",
    "../hooks/useThemeSync.ts",
    "../lib/appPreferencesChild.ts",
    "../lib/workspaceContentWindowProtocol.ts",
  ],
  workspaceContent: [
    "../components/StandaloneWorkspaceFileWindow.tsx",
    "../components/WorkspaceContentWindowShell.tsx",
    "../components/WindowTitlebar.tsx",
    "../hooks/useThemeSync.ts",
    "../lib/appPreferencesChild.ts",
    "../lib/workspaceContentWindowProtocol.ts",
  ],
};

const apiPermissionRequirements: Array<{
  pattern: RegExp;
  permissions: string[];
  requireExplicitGrant?: boolean;
}> = [
  {
    pattern: /\b(?:listen|onCloseRequested)\s*(?:<[^>]*>)?\s*\(/,
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
  {
    pattern: /\.setTheme\s*\(/,
    permissions: ["core:window:allow-set-theme"],
    requireExplicitGrant: true,
  },
  {
    pattern: /\.setFocus\s*\(/,
    permissions: ["core:window:allow-set-focus"],
    requireExplicitGrant: true,
  },
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
    pattern: /from ["']@tauri-apps\/plugin-clipboard-manager["']/,
    permissions: [
      "clipboard-manager:allow-read-text",
      "clipboard-manager:allow-write-text",
    ],
  },
];

const sourceFiles = import.meta.glob("../**/*.{ts,tsx}", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

const capabilities: Record<
  string,
  { permissions: Array<string | { identifier: string }> }
> = {
  default: defaultCapability,
  "terminal-window": terminalCapability,
  "workspace-content-window": workspaceContentCapability,
};

function readSources(paths: string[]): string {
  return paths.map((path) => sourceFiles[path]).join("\n");
}

function capabilityPermissions(capabilityId: string): Set<string> {
  return new Set(
    capabilities[capabilityId].permissions.map((permission) =>
      typeof permission === "string" ? permission : permission.identifier,
    ),
  );
}

describe("native API permissions by window kind", () => {
  it.each(windowKinds.kinds)("grants APIs used by $id", (kind) => {
    const source = readSources(sourcesByWindowKind[kind.id]);
    const permissions = capabilityPermissions(kind.capability);

    for (const requirement of apiPermissionRequirements) {
      if (!requirement.pattern.test(source)) continue;
      for (const permission of requirement.permissions) {
        if (
          !requirement.requireExplicitGrant &&
          permissions.has("core:default") &&
          permission.startsWith("core:")
        ) {
          continue;
        }
        expect(permissions, `${kind.id} is missing ${permission}`).toContain(
          permission,
        );
      }
    }
  });
});

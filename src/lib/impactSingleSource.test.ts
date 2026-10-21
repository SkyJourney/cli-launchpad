import { describe, expect, it } from "vitest";

// The whole frontend source tree as raw text. Keys are relative to this file, so each key is
// normalised to a path relative to `src/` before matching.
const sources = import.meta.glob("../**/*.{ts,tsx}", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

const srcRelative = (key: string): string =>
  new URL(key, "file:///src/lib/").pathname.split("/src/")[1] ?? key;

const productionSources = Object.entries(sources)
  .map(([key, text]) => [srcRelative(key), text] as const)
  .filter(([path]) => !/\.test\.tsx?$/.test(path));

const sourceOf = (path: string): string => {
  const match = productionSources.find(([candidate]) => candidate === path);
  if (!match) throw new Error(`missing source ${path}`);
  return match[1];
};

describe("impact single source", () => {
  it("only workspaceFileBuffer.ts compares a buffer's content with its saved content to decide dirtiness", () => {
    const hits = productionSources
      .filter(([, text]) => /\.content\s*!==\s*[\w.]+\.savedContent/.test(text))
      .map(([path]) => path)
      .sort();
    expect(hits).toEqual(["lib/workspaceFileBuffer.ts"]);
  });

  it("the three dirty-state consumers call isWorkspaceFileBufferDirty", () => {
    for (const path of [
      "lib/appExitImpacts.ts",
      "components/workspaceContentAdapters/builtins.tsx",
      "workspace/domains/fileContentDomain.ts",
    ]) {
      expect(sourceOf(path), path).toContain("isWorkspaceFileBufferDirty(");
    }
    const definition = sourceOf("lib/workspaceFileBuffer.ts");
    expect(
      definition.match(/export function isWorkspaceFileBufferDirty/g)?.length,
    ).toBe(1);
  });

  it("both impact dialogs render their lists through ImpactTitleList", () => {
    const alertDialogs = productionSources.filter(([, text]) =>
      text.includes('role="alertdialog"'),
    );
    expect(alertDialogs.length).toBe(1);
    const closeDialog = alertDialogs[0][1];
    const app = sourceOf("App.tsx");
    expect(app).toContain("<ImpactTitleList");
    expect(app).toContain("summarizeExitImpacts(");
    expect(closeDialog).toContain("<ImpactTitleList");
    expect(closeDialog).toContain("summarizeDisposalImpacts(");
    expect(app).not.toContain('className="app-exit-unsaved-files"');
    expect(closeDialog).not.toContain('className="app-exit-unsaved-files"');
    const component = sourceOf("components/ImpactTitleList.tsx");
    expect(component.match(/className="app-exit-unsaved-files"/g)?.length).toBe(
      1,
    );
    const others = productionSources.filter(
      ([path, text]) =>
        path !== "components/ImpactTitleList.tsx" &&
        text.includes('className="app-exit-unsaved-files"'),
    );
    expect(others).toEqual([]);
  });

  it("exit flush merging lives only in appExitImpacts.ts", () => {
    const guards = sourceOf("workspace/host/workspaceLifecycleGuards.ts");
    expect(guards.match(/mergeExitFlushResults\(/g)?.length).toBe(1);
    expect(guards).not.toContain("isWorkspaceFileBufferNewer(");
    const exitImpacts = sourceOf("lib/appExitImpacts.ts");
    expect(
      exitImpacts.match(/export function mergeExitFlushResults/g)?.length,
    ).toBe(1);
  });
});

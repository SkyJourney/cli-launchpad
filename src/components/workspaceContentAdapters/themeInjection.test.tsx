// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { isValidElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerBuiltinContributions } from "../../bootstrap/registerBuiltinContributions";
import type { ResolvedTheme } from "../../lib/themes";
import { useAppStore } from "../../store/appStore";
import {
  isExcludedFromClosure,
  projectSources,
} from "../../test/sourceClosure";
import { WorkspaceContentView } from "../WorkspaceContentView";
import { getWorkspaceContentAdapter } from "../workspaceContentAdapterRegistry";

const dark: ResolvedTheme = { id: "dark", base: "dark" };
const light: ResolvedTheme = { id: "light", base: "light" };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("file adapter theme injection", () => {
  it("passes the theme from the render context to the file editor", () => {
    const unregister = registerBuiltinContributions();
    try {
      useAppStore.setState({ resolvedTheme: light });
      const view = getWorkspaceContentAdapter("file").render({
        content: { kind: "file", documentId: "doc-1" },
        theme: dark,
        file: {
          document: {
            id: "doc-1",
            directoryId: 1,
            directoryPath: "/project",
            relativePath: "a.txt",
          },
          buffer: undefined,
          readOnly: false,
          edit: vi.fn(),
          save: vi.fn(async () => undefined),
        },
      });
      expect(isValidElement(view)).toBe(true);
      expect(view).toMatchObject({ props: { theme: dark } });
      expect(view).not.toMatchObject({ props: { theme: light } });
    } finally {
      unregister();
    }
  });

  it("adapters do not read the global theme", () => {
    const forbidden = /useResolvedTheme|subscribeResolvedTheme|store\/appStore/;
    expect(forbidden.test('import { useResolvedTheme } from "x"')).toBe(true);
    const adapterSources = Object.entries(projectSources).filter(
      ([path]) =>
        path.startsWith("src/components/workspaceContentAdapters/") &&
        !isExcludedFromClosure(path),
    );
    expect(adapterSources.length).toBeGreaterThanOrEqual(1);
    for (const [path, source] of adapterSources) {
      expect(source, path).not.toMatch(forbidden);
    }
  });

  it("injects the resolved theme into the render context and follows theme changes", () => {
    const unregister = registerBuiltinContributions();
    try {
      const seen: unknown[] = [];
      vi.spyOn(getWorkspaceContentAdapter("pty"), "render").mockImplementation(
        (context) => {
          seen.push(context.theme);
          return null;
        },
      );
      useAppStore.setState({ resolvedTheme: dark });
      const element = (
        <WorkspaceContentView
          content={{ kind: "pty", slotId: "slot-1" }}
          fileDocument={undefined}
          fileBuffer={undefined}
          onEditFile={vi.fn()}
          onSaveFile={vi.fn(async () => undefined)}
        />
      );
      const view = render(element);
      expect(seen[seen.length - 1]).toEqual(dark);

      act(() => {
        useAppStore.setState({ resolvedTheme: light });
      });
      view.rerender(element);
      expect(seen[seen.length - 1]).toEqual(light);
    } finally {
      unregister();
    }
  });
});

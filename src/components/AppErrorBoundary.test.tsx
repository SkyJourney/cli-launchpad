// @vitest-environment jsdom
/// <reference types="vite/client" />
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import boundarySource from "./AppErrorBoundary.tsx?raw";
import mainSource from "../main.tsx?raw";
import { ar } from "../i18n/locales/ar";
import { de } from "../i18n/locales/de";
import { en } from "../i18n/locales/en";
import es from "../i18n/locales/es.json";
import { fr } from "../i18n/locales/fr";
import { ja } from "../i18n/locales/ja";
import { ko } from "../i18n/locales/ko";
import { pt } from "../i18n/locales/pt";
import { ru } from "../i18n/locales/ru";
import { zh } from "../i18n/locales/zh";
import { AppErrorBoundary } from "./AppErrorBoundary";

vi.mock(
  "react-i18next",
  async () => (await import("../test/host/hostMocks")).reactI18nextMock,
);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Thrower(): null {
  useEffect(() => {
    throw new Error("boom");
  }, []);
  return null;
}

const LOCALES = { zh, en, es, de, ja, fr, ar, pt, ru, ko };

describe("AppErrorBoundary", () => {
  it("renders a recoverable fallback instead of unmounting the window", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const onReload = vi.fn();
    const { container } = render(
      <AppErrorBoundary onReload={onReload}>
        <Thrower />
        <span data-testid="child" />
      </AppErrorBoundary>,
    );
    await act(async () => {});

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("appCrash.title");
    expect(alert.textContent).toContain("appCrash.description");
    expect(onReload).toHaveBeenCalledTimes(0);
    fireEvent.click(screen.getByRole("button", { name: "appCrash.reload" }));
    expect(onReload).toHaveBeenCalledTimes(1);
    // 反向断言：窗口没有变成空节点，出错子树也没有继续渲染。
    expect(container.innerHTML).not.toBe("");
    expect(screen.queryByTestId("child")).toBeNull();
    expect(
      errorSpy.mock.calls.filter((call) => call[0] === "[app.render_crashed]"),
    ).toHaveLength(1);
    errorSpy.mockRestore();
  });

  it("is mounted around App in the renderer entry", () => {
    expect(mainSource).toMatch(
      /<AppErrorBoundary>\s*<App\s*\/>\s*<\/AppErrorBoundary>/,
    );
    // 边界位于 QueryClientProvider 之内。
    expect(mainSource.indexOf("<QueryClientProvider")).toBeLessThan(
      mainSource.indexOf("<AppErrorBoundary>"),
    );
    expect(mainSource).toContain('from "./components/AppErrorBoundary"');
  });

  it("renders its children when nothing fails", () => {
    render(
      <AppErrorBoundary>
        <span data-testid="child" />
      </AppErrorBoundary>,
    );

    expect(screen.getByTestId("child")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("wires the default reload to window.location.reload", () => {
    expect(boundarySource).toContain("window.location.reload()");
    expect(boundarySource).toMatch(/onReload\s*\?\?\s*reloadWindow/);
    // 不得用赋值跳转代替重载。
    expect(boundarySource).not.toContain("location.href =");
  });

  it("keeps the boundary free of effects and translation outside the render path", () => {
    expect(boundarySource).not.toMatch(/\buseEffect\b/);
    expect(boundarySource).not.toMatch(/\buseLayoutEffect\b/);
    // 翻译钩子只能出现在 AppCrashFallback 之内。
    const head = boundarySource.split("function AppCrashFallback")[0];
    expect(head).not.toContain("useTranslation(");
    const afterCatch = boundarySource.split("componentDidCatch(")[1] ?? "";
    const catchBody = afterCatch.split("render()")[0];
    expect(catchBody.length).toBeGreaterThan(0);
    expect(catchBody).not.toMatch(/\bt\(/);
    expect(catchBody).not.toContain("useTranslation");
  });

  it.each(Object.keys(LOCALES) as Array<keyof typeof LOCALES>)(
    "has appCrash texts in %s",
    (language) => {
      const crash = (
        LOCALES[language] as unknown as { appCrash?: Record<string, unknown> }
      ).appCrash;

      expect(crash).toBeDefined();
      for (const key of ["title", "description", "reload"] as const) {
        expect(typeof crash?.[key]).toBe("string");
        expect((crash?.[key] as string).length).toBeGreaterThan(0);
      }
      // 值不得是键名本身，三段文本互不相同。
      expect(crash?.title).not.toBe("appCrash.title");
      expect(crash?.description).not.toBe("appCrash.description");
      expect(crash?.reload).not.toBe("appCrash.reload");
      expect(
        new Set([crash?.title, crash?.description, crash?.reload]).size,
      ).toBe(3);
    },
  );
});

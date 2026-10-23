// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 不 mock react-i18next：本文件用真实 i18n 实例，证明回退界面显示的是真实译文。
import { i18n } from "../i18n";
import { AppErrorBoundary } from "./AppErrorBoundary";

function Thrower(): null {
  useEffect(() => {
    throw new Error("boom");
  }, []);
  return null;
}

beforeEach(async () => {
  await act(async () => {
    await i18n.changeLanguage("en");
  });
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await act(async () => {
    await i18n.changeLanguage("en");
  });
});

describe("AppErrorBoundary with the real i18n instance", () => {
  it("renders the translated fallback and follows language changes", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <AppErrorBoundary>
        <Thrower />
      </AppErrorBoundary>,
    );
    await act(async () => {});

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Something went wrong");
    expect(screen.getByRole("button", { name: "Reload window" })).toBeTruthy();

    await act(async () => {
      await i18n.changeLanguage("zh");
    });

    expect(screen.getByRole("alert").textContent).toContain("出现了意外错误");
    expect(screen.getByRole("button", { name: "重新加载窗口" })).toBeTruthy();
    // 反向断言：切换语言后回退界面仍然存在，英文文案已消失，也没有回显键名。
    expect(screen.getByRole("alert").textContent).not.toContain(
      "Something went wrong",
    );
    expect(screen.getByRole("alert").textContent).not.toContain("appCrash.");
  });
});

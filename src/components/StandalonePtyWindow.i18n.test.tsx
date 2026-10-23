// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "sonner",
  async () => (await import("../test/host/hostMocks")).sonnerMock,
);
vi.mock(
  "./PtyTerminal",
  async () => (await import("../test/host/hostMocks")).ptyTerminalMock,
);
// Pass-through spy: the real handoff runtime still runs; only the calls are recorded.
vi.mock("./workspaceContentHandoffRuntime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./workspaceContentHandoffRuntime")>();
  return {
    ...actual,
    rollbackWorkspaceContentHandoff: vi.fn(
      actual.rollbackWorkspaceContentHandoff,
    ),
  };
});

import { i18n } from "../i18n";
import { tauriMock } from "../test/tauriMock";
import {
  fakeTerminals,
  onFakeTerminalCreated,
  resetFakeTerminals,
} from "../test/host/hostMocks";
import {
  DEFAULT_PTY_WINDOW_LABEL,
  deferred,
  emitToWindow,
  flush,
  mountPtyWindow,
} from "../test/host/workspaceHarness";
import { rollbackWorkspaceContentHandoff } from "./workspaceContentHandoffRuntime";

type PtyWindow = Awaited<ReturnType<typeof mountPtyWindow>>;

const RETURN_TOKEN = "return-token-1";
const LANGUAGES = [
  "zh",
  "en",
  "es",
  "de",
  "ja",
  "fr",
  "ar",
  "pt",
  "ru",
  "ko",
] as const;
const RETURN_KEYS = [
  "pty.returnUnknownError",
  "pty.returnExpired",
  "pty.returnRequestFailed",
] as const;

let win: PtyWindow | undefined;
let uuidSpy: { mockRestore: () => void } | undefined;

beforeEach(() => {
  vi.mocked(rollbackWorkspaceContentHandoff).mockClear();
});

afterEach(async () => {
  win?.dispose();
  win = undefined;
  cleanup();
  resetFakeTerminals();
  uuidSpy?.mockRestore();
  uuidSpy = undefined;
  vi.useRealTimers();
  await act(async () => {
    await i18n.changeLanguage("en");
  });
  await flush();
  expect(tauriMock.state.eventListeners).toHaveLength(0);
});

async function setLanguage(language: (typeof LANGUAGES)[number]) {
  await act(async () => {
    await i18n.changeLanguage(language);
  });
}

async function mountReadyWindow(language: "en" | "zh") {
  await setLanguage(language);
  win = await mountPtyWindow();
  await flush(10);
  return win;
}

function returnButton() {
  const button = document.querySelector<HTMLButtonElement>(
    "button.standalone-pty-return",
  );
  if (!button) throw new Error("return button is not rendered");
  return button;
}

function errorText() {
  return document.querySelector(".standalone-pty-error")?.textContent ?? null;
}

/** Seeds both token sources so the test does not depend on which one the window uses. */
function seedReturnToken() {
  fakeTerminals[0].captureHandoff.mockResolvedValueOnce({
    token: RETURN_TOKEN,
  });
  uuidSpy = vi
    .spyOn(globalThis.crypto, "randomUUID")
    .mockReturnValueOnce(RETURN_TOKEN as ReturnType<typeof crypto.randomUUID>);
}

function rollbackReasons() {
  return vi.mocked(rollbackWorkspaceContentHandoff).mock.calls.map((call) => {
    const reason = call[2];
    return reason instanceof Error ? reason.message : String(reason);
  });
}

describe("StandalonePtyWindow language handling", () => {
  it("re-renders the status and the return button in the new language without restarting the handshake", async () => {
    await setLanguage("en");
    const attach = deferred<{ sessionId: string; state: string }>();
    onFakeTerminalCreated((handle) => {
      handle.attachHandoff.mockImplementationOnce(() => attach.promise);
    });
    win = await mountPtyWindow();
    await flush(5);
    expect(screen.getByText("Creating terminal session…")).toBeTruthy();
    const listenersBefore = tauriMock.state.eventListeners.length;
    expect(listenersBefore).toBeGreaterThan(0);

    await setLanguage("zh");
    await flush(5);

    expect(screen.getByText("正在创建终端会话…")).toBeTruthy();
    expect(screen.queryByText("Creating terminal session…")).toBeNull();
    expect(tauriMock.state.eventListeners).toHaveLength(listenersBefore);
    expect(fakeTerminals[0].attachHandoff).toHaveBeenCalledTimes(1);

    attach.resolve({ sessionId: "session-1", state: "running" });
    await flush(10);

    const button = returnButton();
    expect(button.disabled).toBe(false);
    expect(button.textContent).toContain("返回工作区");
    expect(screen.queryByText("正在创建终端会话…")).toBeNull();
    expect(fakeTerminals[0].attachHandoff).toHaveBeenCalledTimes(1);
    expect(win.errors).toEqual([]);
  });

  it("localizes the fallback text when pty-return-failed carries no message", async () => {
    await mountReadyWindow("en");
    seedReturnToken();
    await act(async () => {
      fireEvent.click(returnButton());
    });
    await flush(10);
    expect(errorText()).toBeNull();

    await setLanguage("zh");
    await emitToWindow(DEFAULT_PTY_WINDOW_LABEL, "pty-return-failed", {
      instanceId: "slot-1",
      token: RETURN_TOKEN,
    });
    await flush(5);

    expect(errorText()).toBe("无法返回工作区：未知错误");
    expect(errorText()).not.toContain("Unknown error");
    expect(win?.errors).toEqual([]);
  });

  it("formats a return timeout in the language that is active when the timer fires", async () => {
    await mountReadyWindow("en");
    seedReturnToken();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await act(async () => {
      fireEvent.click(returnButton());
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(errorText()).toBeNull();

    await setLanguage("zh");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(14_999);
    });
    expect(errorText()).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(errorText()).toBe("无法返回工作区：主工作区响应超时。");
    expect(errorText()).not.toContain("Could not return");
    expect(win?.errors).toEqual([]);
  });

  it("passes localized reasons to the handoff rollback when a return attempt expires", async () => {
    await mountReadyWindow("en");
    const capture = deferred<{ token: string }>();
    fakeTerminals[0].captureHandoff.mockImplementationOnce(
      () => capture.promise,
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await act(async () => {
      fireEvent.click(returnButton());
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(rollbackReasons()).toEqual([
      "The main workspace did not respond in time.",
    ]);

    capture.resolve({ token: "late-token" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(rollbackReasons()).toEqual([
      "The main workspace did not respond in time.",
      "The return request has expired.",
    ]);
    const reasons = vi
      .mocked(rollbackWorkspaceContentHandoff)
      .mock.calls.map((call) => call[2]);
    expect(reasons.every((reason) => reason instanceof Error)).toBe(true);
  });

  it("passes a localized reason to the handoff rollback when pty-return-failed has no message", async () => {
    await mountReadyWindow("en");
    seedReturnToken();
    await act(async () => {
      fireEvent.click(returnButton());
    });
    await flush(10);
    expect(rollbackReasons()).toEqual([]);

    await emitToWindow(DEFAULT_PTY_WINDOW_LABEL, "pty-return-failed", {
      instanceId: "slot-1",
      token: RETURN_TOKEN,
    });
    await flush(5);

    expect(rollbackReasons()).toEqual(["The return request failed."]);
    expect(rollbackReasons()).not.toContain("返回请求失败");
  });

  it("defines the three return error keys in all ten languages", () => {
    const text = (language: string, key: string) =>
      i18n.getResource(language, "translation", key);

    expect(RETURN_KEYS.map((key) => text("en", key))).toEqual([
      "Unknown error",
      "The return request has expired.",
      "The return request failed.",
    ]);
    expect(RETURN_KEYS.map((key) => text("zh", key))).toEqual([
      "未知错误",
      "返回请求已过期。",
      "返回请求失败。",
    ]);
    for (const language of LANGUAGES) {
      for (const key of RETURN_KEYS) {
        const value = text(language, key);
        expect(typeof value, `${language} ${key}`).toBe("string");
        expect((value as string).length, `${language} ${key}`).toBeGreaterThan(
          1,
        );
        expect(value, `${language} ${key}`).not.toBe(key);
        if (language !== "en") {
          expect(value, `${language} ${key} must be translated`).not.toBe(
            text("en", key),
          );
        }
      }
    }
  });
});

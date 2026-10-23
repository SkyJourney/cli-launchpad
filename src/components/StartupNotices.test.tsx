// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import capabilityDefault from "../../src-tauri/capabilities/default.json";
import capabilityTerminal from "../../src-tauri/capabilities/terminal-window.json";
import capabilityWorkspaceContent from "../../src-tauri/capabilities/workspace-content-window.json";
import { ar } from "../i18n/locales/ar";
import { de } from "../i18n/locales/de";
import { en } from "../i18n/locales/en";
import { fr } from "../i18n/locales/fr";
import { ja } from "../i18n/locales/ja";
import { ko } from "../i18n/locales/ko";
import { pt } from "../i18n/locales/pt";
import { ru } from "../i18n/locales/ru";
import { zh } from "../i18n/locales/zh";
import es from "../i18n/locales/es.json";
import { tauriMock } from "../test/tauriMock";
import {
  flush,
  invokes,
  mountFileWindow,
  mountPtyWindow,
} from "../test/host/workspaceHarness";
import { StartupNotices } from "./StartupNotices";

vi.mock(
  "react-i18next",
  async () => (await import("../test/host/hostMocks")).reactI18nextMock,
);

function takeCalls() {
  return tauriMock.state.invokeCalls.filter(
    (call) => call.command === "take_startup_notices",
  );
}

afterEach(() => {
  cleanup();
  tauriMock.setInvokeHandler(() => undefined);
});

describe("startup notices", () => {
  it("shows the abnormal exit notice once and lets the user dismiss it", async () => {
    tauriMock.setInvokeHandler((command) =>
      command === "take_startup_notices"
        ? [{ kind: "abnormal_exit_detected", startedAtMs: 1700000000000 }]
        : undefined,
    );
    render(<StartupNotices ready />);

    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toContain("startupNotice.abnormalExitWithTime");
    expect(text).toContain('"time"');

    fireEvent.click(
      screen.getByRole("button", { name: "startupNotice.dismiss" }),
    );
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(takeCalls()).toHaveLength(1);

    cleanup();
    tauriMock.setInvokeHandler((command) =>
      command === "take_startup_notices"
        ? [{ kind: "abnormal_exit_detected", startedAtMs: null }]
        : undefined,
    );
    render(<StartupNotices ready />);
    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    const withoutTime = screen.getByRole("status").textContent ?? "";
    expect(withoutTime).toContain("startupNotice.abnormalExit");
    expect(withoutTime).not.toContain("abnormalExitWithTime");
    expect(withoutTime).not.toContain('"time"');
  });

  it("shows nothing after a clean start", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    tauriMock.setInvokeHandler((command) =>
      command === "take_startup_notices" ? [] : undefined,
    );
    render(<StartupNotices ready />);

    await waitFor(() => expect(takeCalls()).toHaveLength(1));
    await flush();
    expect(screen.queryByRole("status")).toBeNull();
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("never claims that anything was restored", () => {
    const locales: Array<[string, Record<string, unknown>]> = [
      ["en", en as unknown as Record<string, unknown>],
      ["zh", zh as unknown as Record<string, unknown>],
      ["de", de as unknown as Record<string, unknown>],
      ["ja", ja as unknown as Record<string, unknown>],
      ["fr", fr as unknown as Record<string, unknown>],
      ["ar", ar as unknown as Record<string, unknown>],
      ["pt", pt as unknown as Record<string, unknown>],
      ["ru", ru as unknown as Record<string, unknown>],
      ["ko", ko as unknown as Record<string, unknown>],
      ["es", es as unknown as Record<string, unknown>],
    ];
    const forbidden = [
      "恢复",
      "已恢复",
      "restored",
      "recovered",
      "wiederhergestellt",
      "restauré",
      "récupéré",
      "restaur",
      "recuper",
      "восстановлен",
      "復元",
      "回復",
      "복원",
      "복구",
      "استعاد",
      "استرجاع",
    ];
    for (const [language, locale] of locales) {
      const group = locale.startupNotice as Record<string, string> | undefined;
      expect(group, language).toBeDefined();
      const { abnormalExit, abnormalExitWithTime, dismiss } = group!;
      for (const value of [abnormalExit, abnormalExitWithTime, dismiss]) {
        expect(typeof value, language).toBe("string");
        expect(value.length, language).toBeGreaterThan(0);
        for (const word of forbidden) {
          expect(value.toLowerCase(), `${language}: ${word}`).not.toContain(
            word.toLowerCase(),
          );
        }
      }
      expect(abnormalExitWithTime, language).toContain("{{time}}");
      expect(abnormalExit, language).not.toContain("{{time}}");
    }
    expect(en.startupNotice.abnormalExit).toContain("may be lost");
    expect(en.startupNotice.abnormalExitWithTime).toContain("may be lost");
    expect(zh.startupNotice.abnormalExit).toContain("可能丢失");
    expect(zh.startupNotice.abnormalExitWithTime).toContain("可能丢失");
  });

  it("fetches notices once per window lifetime even under StrictMode", async () => {
    tauriMock.setInvokeHandler((command) =>
      command === "take_startup_notices"
        ? [{ kind: "abnormal_exit_detected", startedAtMs: 1700000000000 }]
        : undefined,
    );
    const { rerender } = render(
      <StrictMode>
        <StartupNotices ready />
      </StrictMode>,
    );

    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    expect(takeCalls()).toHaveLength(1);
    expect(screen.getAllByRole("status")).toHaveLength(1);

    rerender(
      <StrictMode>
        <StartupNotices ready />
      </StrictMode>,
    );
    expect(takeCalls()).toHaveLength(1);
  });

  it("is not requested from detached windows", async () => {
    const pty = await mountPtyWindow();
    pty.dispose();
    cleanup();
    const file = await mountFileWindow();
    file.dispose();
    cleanup();

    expect(invokes("take_startup_notices")).toHaveLength(0);
    const permissionOf = (capability: { permissions: unknown[] }) =>
      capability.permissions;
    expect(permissionOf(capabilityDefault)).toContain(
      "allow-take-startup-notices",
    );
    expect(permissionOf(capabilityTerminal)).not.toContain(
      "allow-take-startup-notices",
    );
    expect(permissionOf(capabilityWorkspaceContent)).not.toContain(
      "allow-take-startup-notices",
    );
  });
});

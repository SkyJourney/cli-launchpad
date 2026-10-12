import { afterEach, describe, expect, it, vi } from "vitest";
import themeSyncSource from "../hooks/useThemeSync.ts?raw";
import workspaceSource from "../components/PtyWorkspace.tsx?raw";
import { reportWindowSyncFailure } from "./windowSyncDiagnostics";

const { toastError, reportWindowSyncFailureToBackend } = vi.hoisted(() => ({
  toastError: vi.fn(),
  reportWindowSyncFailureToBackend: vi.fn(() => Promise.resolve()),
}));
vi.mock("sonner", () => ({ toast: { error: toastError } }));
vi.mock("./tauri", () => ({ reportWindowSyncFailureToBackend }));

describe("reportWindowSyncFailure", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    toastError.mockReset();
  });

  it("always logs a console warning with the code and description", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = new Error("boom");

    reportWindowSyncFailure("window.x", error, "描述");

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe("[window.x] 描述");
    expect(warn.mock.calls[0]?.[1]).toBe(error);

    warn.mockClear();
    reportWindowSyncFailure("window.x", error);
    expect(warn.mock.calls[0]?.[0]).toBe("[window.x] 原生窗口偏好同步失败");
  });

  it("surfaces the failure as a toast in development builds", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    reportWindowSyncFailure("window.theme_sync_failed", {
      code: "acl.denied",
      message: "x",
    });

    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith("window.theme_sync_failed: x");
  });

  it("does not toast in production builds but still logs", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("DEV", false);

    reportWindowSyncFailure("window.theme_sync_failed", new Error("boom"));

    expect(toastError).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("describes non-error values in the toast text", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    reportWindowSyncFailure("window.y", "plain failure");
    reportWindowSyncFailure("window.y", undefined);

    expect(toastError.mock.calls[0]?.[0]).toBe("window.y: plain failure");
    expect(toastError.mock.calls[1]?.[0]).toBe("window.y: undefined");
  });
});

describe("window sync failure reporting contract", () => {
  it("routes useThemeSync and the detached focus failure through the shared reporter", () => {
    expect(themeSyncSource).toContain('from "../lib/windowSyncDiagnostics"');
    expect(themeSyncSource).not.toMatch(/function reportWindowSyncFailure/);
    // Prettier may wrap the arguments onto several lines, so match across whitespace.
    expect(workspaceSource).toMatch(
      /reportWindowSyncFailure\(\s*"window\.set_focus_failed"/,
    );
    expect(workspaceSource).not.toContain(
      'console.warn("[window.set_focus_failed]',
    );
  });
});

describe("reportWindowSyncFailure backend channel", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    toastError.mockReset();
    reportWindowSyncFailureToBackend.mockClear();
  });

  it("sends every failure to the application log, including production builds", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("DEV", false);

    reportWindowSyncFailure(
      "window.theme_sync_failed",
      new Error("boom"),
      "描述",
    );

    expect(reportWindowSyncFailureToBackend).toHaveBeenCalledWith(
      "window.theme_sync_failed",
      "描述: boom",
    );
    expect(toastError).not.toHaveBeenCalled();
  });

  it("still toasts in development builds and also sends to the log", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    reportWindowSyncFailure(
      "window.theme_sync_failed",
      new Error("boom"),
      "描述",
    );

    expect(toastError).toHaveBeenCalledWith("window.theme_sync_failed: boom");
    expect(reportWindowSyncFailureToBackend).toHaveBeenCalledWith(
      "window.theme_sync_failed",
      "描述: boom",
    );
  });

  it("does not throw into the caller when the backend call fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    reportWindowSyncFailureToBackend.mockImplementationOnce(() => {
      throw new Error("ipc down");
    });

    expect(() => reportWindowSyncFailure("window.y", "plain")).not.toThrow();
    await Promise.resolve();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does not surface an asynchronous backend rejection either", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    reportWindowSyncFailureToBackend.mockRejectedValueOnce(
      new Error("ipc down"),
    );

    expect(() => reportWindowSyncFailure("window.z", "plain")).not.toThrow();
    await Promise.resolve();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

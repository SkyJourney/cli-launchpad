import { describe, expect, it, vi } from "vitest";
import {
  formatAppError,
  getAppErrorCode,
  getAppErrorMessage,
  isProjectIdentityChangedError,
} from "./appErrors";

describe("serialized application errors", () => {
  it("reads a coded IPC error without stringifying the object", () => {
    const error = {
      code: "project_identity_changed",
      message: "The project path changed",
    };
    expect(getAppErrorCode(error)).toBe("project_identity_changed");
    expect(getAppErrorMessage(error)).toBe("The project path changed");
    expect(isProjectIdentityChangedError(error)).toBe(true);
  });

  it("keeps support for ordinary string and Error failures", () => {
    expect(getAppErrorMessage("failed")).toBe("failed");
    expect(getAppErrorMessage(new Error("failed"))).toBe("failed");
    expect(isProjectIdentityChangedError("project_identity_changed")).toBe(
      false,
    );
  });

  it("formats known error codes with localized text and safe params", () => {
    const translator = vi.fn(
      (key: string, options?: { defaultValue?: string; maxBytes?: number }) =>
        key === "errors.fileTooLarge"
          ? `Maximum size: ${options?.maxBytes}`
          : (options?.defaultValue ?? key),
    );
    const error = {
      code: "file.too_large",
      message: "文件过大",
      params: { maxBytes: 4096, ignored: { private: true } },
    };

    expect(formatAppError(error, translator as never)).toBe(
      "Maximum size: 4096",
    );
    expect(translator).toHaveBeenCalledWith("errors.fileTooLarge", {
      maxBytes: 4096,
      defaultValue: "文件过大",
    });
  });

  it("falls back to the compatibility message for unknown codes", () => {
    const translator = vi.fn();
    expect(
      formatAppError(
        { code: "future.error", message: "Readable fallback" },
        translator as never,
      ),
    ).toBe("Readable fallback");
    expect(translator).not.toHaveBeenCalled();
  });
});

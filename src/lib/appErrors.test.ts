// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import errorCodes from "../../contracts/error-codes.json";
import { APP_LANGUAGES } from "../i18n";
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
import {
  APP_ERROR_TRANSLATION_KEYS,
  formatAppError,
  formatAppErrorState,
  getAppErrorCode,
  getAppErrorMessage,
  isProjectIdentityChangedError,
  normalizeAppErrorCode,
  toAppErrorState,
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

describe("error code contract", () => {
  const aliasKeys = Object.keys(errorCodes.aliases);

  it("maps exactly the codes listed by the contract", () => {
    const expected = [
      ...errorCodes.items,
      ...errorCodes.frontendCodes,
      ...errorCodes.reservedCodes,
      ...aliasKeys,
    ].sort();
    expect(Object.keys(APP_ERROR_TRANSLATION_KEYS).sort()).toEqual(expected);
    // Codes that no backend path produces. The owner, handoff and exec-busy codes now have
    // producers (077b), so they are no longer listed here.
    for (const dead of ["file.conflict"]) {
      expect(APP_ERROR_TRANSLATION_KEYS).not.toHaveProperty(dead);
    }
  });

  it("accepts only dotted codes plus the aliases the contract lists", () => {
    const dotted = /^[a-z]+(\.[a-z0-9_]+)+$/;
    for (const code of [
      ...errorCodes.items,
      ...errorCodes.frontendCodes,
      ...errorCodes.reservedCodes,
    ]) {
      expect(code).toMatch(dotted);
    }
    for (const [alias, target] of Object.entries(errorCodes.aliases)) {
      expect(errorCodes.items).toContain(target);
      expect(normalizeAppErrorCode(alias)).toBe(target);
      const translator = (key: string) => `t:${key}`;
      expect(
        formatAppError({ code: alias, message: "x" }, translator as never),
      ).toBe(
        formatAppError({ code: target, message: "x" }, translator as never),
      );
    }
    expect(normalizeAppErrorCode("future.error")).toBe("future.error");
    expect(normalizeAppErrorCode(undefined)).toBeUndefined();
    expect(normalizeAppErrorCode("constructor")).toBe("constructor");
    const fallback = (key: string) => `t:${key}`;
    expect(
      formatAppError(
        { code: "constructor", message: "kept" },
        fallback as never,
      ),
    ).toBe("kept");
  });

  const locales = { ar, de, en, es, fr, ja, ko, pt, ru, zh } as Record<
    string,
    unknown
  >;
  it.each(APP_LANGUAGES)(
    "has a translation for every mapped error code in %s",
    (language) => {
      const locale = locales[language];
      expect(locale).toBeDefined();
      for (const key of Object.values(APP_ERROR_TRANSLATION_KEYS)) {
        const value = key
          .split(".")
          .reduce<unknown>(
            (node, part) =>
              (node as Record<string, unknown> | undefined)?.[part],
            locale,
          );
        expect(typeof value, `${language}: ${key}`).toBe("string");
        expect((value as string).length, `${language}: ${key}`).toBeGreaterThan(
          0,
        );
        expect(value, `${language}: ${key}`).not.toBe(key);
      }
    },
  );
});

describe("AppErrorState", () => {
  const translator = vi.fn((key: string, options?: Record<string, unknown>) => {
    if (key === "errors.generic") return "The operation failed.";
    if (key === "errors.fileTooLarge")
      return "The file exceeds the allowed size.";
    if (key === "pty.returnFailed")
      return `Return failed: ${String(options?.error)}`;
    return key;
  });
  const t = translator as never;

  it("keeps code, params and message", () => {
    const state = toAppErrorState({
      code: "file.too_large",
      message: "文件超限",
      params: { maxBytes: 1 },
    });
    expect(state).toEqual({
      code: "file.too_large",
      params: { maxBytes: 1 },
      message: "文件超限",
    });
    expect(state).not.toHaveProperty("wrapKey");
  });

  it("falls back to the message for an unknown code", () => {
    const state = toAppErrorState({ code: "x.y", message: "原始" });
    expect(formatAppErrorState(state, t)).toBe("原始");
  });

  it("renders app.internal as the generic text and not the backend message", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const state = toAppErrorState({
      code: "app.internal",
      message: "后端内部细节",
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const text = formatAppErrorState(state, t);
    expect(text).toBe("The operation failed.");
    expect(text).not.toContain("后端内部细节");
    warn.mockRestore();
  });

  it("does not log a known code", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    toAppErrorState({ code: "file.too_large", message: "m" });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("wraps the formatted error with wrapKey", () => {
    const state = toAppErrorState(
      { code: "file.too_large", message: "m" },
      "pty.returnFailed",
    );
    expect(formatAppErrorState(state, t)).toBe(
      "Return failed: The file exceeds the allowed size.",
    );
  });
});

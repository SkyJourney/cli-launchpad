// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

// Real i18n instance: this file proves the state re-renders in another language.
import { i18n } from "../i18n";
import { en } from "../i18n/locales/en";
import { zh } from "../i18n/locales/zh";
import { formatAppErrorState, toAppErrorState } from "./appErrors";

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("error state rendering", () => {
  it("re-renders the same error state in another language without recreating it", async () => {
    const state = toAppErrorState({ code: "file.too_large", message: "m" });

    await i18n.changeLanguage("en");
    expect(formatAppErrorState(state, i18n.t.bind(i18n) as never)).toBe(
      en.errors.fileTooLarge,
    );

    await i18n.changeLanguage("zh");
    expect(formatAppErrorState(state, i18n.t.bind(i18n) as never)).toBe(
      zh.errors.fileTooLarge,
    );

    // Reverse: the two languages render different text from the same object.
    expect(en.errors.fileTooLarge).not.toBe(zh.errors.fileTooLarge);
  });
});

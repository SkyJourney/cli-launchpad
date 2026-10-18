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

export const LOCALES: Record<string, unknown> = {
  ar,
  de,
  en,
  es,
  fr,
  ja,
  ko,
  pt,
  ru,
  zh,
};

/** 按点分键取值；取不到返回 undefined。 */
export function lookupLocale(locale: unknown, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (current, part) =>
        current && typeof current === "object"
          ? (current as Record<string, unknown>)[part]
          : undefined,
      locale,
    );
}

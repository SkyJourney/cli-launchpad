import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { en } from "./locales/en";
import { zh } from "./locales/zh";
import { de } from "./locales/de";
import { ja } from "./locales/ja";
import { fr } from "./locales/fr";
import { ar } from "./locales/ar";
import { pt } from "./locales/pt";
import { ru } from "./locales/ru";
import { ko } from "./locales/ko";
import es from "./locales/es.json";

type LocaleShape<T> = {
  [K in keyof T]: T[K] extends string ? string : LocaleShape<T[K]>;
};

export const APP_LANGUAGES = [
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

export type AppLanguage = (typeof APP_LANGUAGES)[number];

const resources = {
  zh: { translation: zh },
  en: { translation: en },
  es: { translation: es },
  de: { translation: de },
  ja: { translation: ja },
  fr: { translation: fr },
  ar: { translation: ar },
  pt: { translation: pt },
  ru: { translation: ru },
  ko: { translation: ko },
} satisfies Record<AppLanguage, { translation: LocaleShape<typeof en> }>;

const LANGUAGE_STORAGE_KEY = "cli-launchpad.language";

function normalizeLanguage(language: string | null): AppLanguage | null {
  const base = language?.toLowerCase().split(/[-_]/, 1)[0];
  return APP_LANGUAGES.find((candidate) => candidate === base) ?? null;
}

function getInitialLanguage(): AppLanguage {
  return (
    normalizeLanguage(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)) ??
    [window.navigator.language, ...window.navigator.languages]
      .map(normalizeLanguage)
      .find((language) => language !== null) ??
    "en"
  );
}

void i18n.use(initReactI18next).init({
  resources,
  lng: getInitialLanguage(),
  fallbackLng: "en",
  supportedLngs: APP_LANGUAGES,
  load: "languageOnly",
  initAsync: false,
  interpolation: {
    escapeValue: false,
  },
});

function syncDocumentLanguage(language: string) {
  const appLanguage = normalizeLanguage(language) ?? "en";
  document.documentElement.lang =
    appLanguage === "zh"
      ? "zh-CN"
      : appLanguage === "pt"
        ? "pt-BR"
        : appLanguage;
  document.documentElement.dir = appLanguage === "ar" ? "rtl" : "ltr";
}

syncDocumentLanguage(i18n.resolvedLanguage ?? i18n.language);
i18n.on("languageChanged", syncDocumentLanguage);

export async function setAppLanguage(language: AppLanguage) {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  await i18n.changeLanguage(language);
}

export async function applyRemoteAppLanguage(language: AppLanguage) {
  await i18n.changeLanguage(language);
}

export function isAppLanguage(value: unknown): value is AppLanguage {
  return (
    typeof value === "string" && APP_LANGUAGES.includes(value as AppLanguage)
  );
}

export function getAppLanguage(): AppLanguage {
  return normalizeLanguage(i18n.resolvedLanguage ?? i18n.language) ?? "en";
}

export { i18n };

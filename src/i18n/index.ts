import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { en } from "./locales/en";
import { zh } from "./locales/zh";

export type AppLanguage = "zh" | "en";

const LANGUAGE_STORAGE_KEY = "cli-launchpad.language";

function normalizeLanguage(language: string | null): AppLanguage | null {
  if (language?.toLowerCase().startsWith("zh")) {
    return "zh";
  }
  if (language?.toLowerCase().startsWith("en")) {
    return "en";
  }
  return null;
}

function getInitialLanguage(): AppLanguage {
  return (
    normalizeLanguage(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)) ??
    normalizeLanguage(window.navigator.language) ??
    "en"
  );
}

void i18n.use(initReactI18next).init({
  resources: {
    zh: { translation: zh },
    en: { translation: en },
  },
  lng: getInitialLanguage(),
  fallbackLng: "zh",
  supportedLngs: ["zh", "en"],
  load: "languageOnly",
  initAsync: false,
  interpolation: {
    escapeValue: false,
  },
});

function syncDocumentLanguage(language: string) {
  document.documentElement.lang = language.startsWith("zh") ? "zh-CN" : "en";
}

syncDocumentLanguage(i18n.resolvedLanguage ?? i18n.language);
i18n.on("languageChanged", syncDocumentLanguage);

export async function setAppLanguage(language: AppLanguage) {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  await i18n.changeLanguage(language);
}

export function getAppLanguage(): AppLanguage {
  return i18n.resolvedLanguage?.startsWith("zh") ? "zh" : "en";
}

export { i18n };

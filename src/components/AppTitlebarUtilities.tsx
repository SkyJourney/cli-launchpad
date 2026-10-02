import {
  Check,
  Info,
  Monitor,
  Moon,
  Settings,
  SquareTerminal,
  Sun,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import clsx from "clsx";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  isExecutionActive,
  useExecutionTasks,
} from "../hooks/useExecutionTasks";
import {
  APP_LANGUAGES,
  getAppLanguage,
  setAppLanguage,
  type AppLanguage,
} from "../i18n";
import { useAppStore, type ThemeMode } from "../store/appStore";
import { AnchoredPopover } from "./AnchoredPopover";

const THEME_OPTIONS: {
  icon: LucideIcon;
  labelKey: "theme.light" | "theme.dark" | "theme.system";
  value: ThemeMode;
}[] = [
  { icon: Sun, labelKey: "theme.light", value: "light" },
  { icon: Moon, labelKey: "theme.dark", value: "dark" },
  { icon: Monitor, labelKey: "theme.system", value: "system" },
];

const LANGUAGE_NAMES: Record<AppLanguage, { code: string; label: string }> = {
  zh: { code: "ZH", label: "简体中文" },
  en: { code: "EN", label: "English" },
  es: { code: "ES", label: "Español" },
  de: { code: "DE", label: "Deutsch" },
  ja: { code: "JA", label: "日本語" },
  fr: { code: "FR", label: "Français" },
  ar: { code: "AR", label: "العربية" },
  pt: { code: "PT", label: "Português" },
  ru: { code: "RU", label: "Русский" },
  ko: { code: "KO", label: "한국어" },
};

const LANGUAGE_OPTIONS = APP_LANGUAGES.map((value) => ({
  ...LANGUAGE_NAMES[value],
  value,
}));

export function AppTitlebarUtilities() {
  const { t } = useTranslation();
  const view = useAppStore((state) => state.view);
  const setView = useAppStore((state) => state.setView);
  const themeMode = useAppStore((state) => state.themeMode);
  const setThemeMode = useAppStore((state) => state.setThemeMode);
  const tasks = useExecutionTasks();
  const [showThemeMenu, setShowThemeMenu] = useState(false);
  const [showLanguageMenu, setShowLanguageMenu] = useState(false);
  const themeButtonRef = useRef<HTMLButtonElement | null>(null);
  const languageButtonRef = useRef<HTMLButtonElement | null>(null);
  const activeCount =
    tasks.data?.filter((task) => isExecutionActive(task.status)).length ?? 0;
  const currentTheme =
    THEME_OPTIONS.find((option) => option.value === themeMode) ??
    THEME_OPTIONS[2];
  const CurrentThemeIcon = currentTheme.icon;
  const currentLanguage = getAppLanguage();
  const currentLanguageOption =
    LANGUAGE_OPTIONS.find((option) => option.value === currentLanguage) ??
    LANGUAGE_OPTIONS[APP_LANGUAGES.indexOf("en")];

  return (
    <div className="window-titlebar-utilities">
      <button
        ref={languageButtonRef}
        type="button"
        className={clsx(
          "icon-button window-titlebar-action-button titlebar-utility-button",
          { active: showLanguageMenu },
        )}
        title={t("language.current", {
          language: currentLanguageOption.label,
        })}
        aria-label={t("language.current", {
          language: currentLanguageOption.label,
        })}
        aria-haspopup="menu"
        aria-expanded={showLanguageMenu}
        onClick={() => {
          setShowThemeMenu(false);
          setShowLanguageMenu((value) => !value);
        }}
      >
        <span className="titlebar-language-code">
          {currentLanguageOption.code}
        </span>
      </button>
      {showLanguageMenu && (
        <AnchoredPopover
          anchorRef={languageButtonRef}
          ariaLabel={t("language.select")}
          className="preference-popover"
          onClose={() => setShowLanguageMenu(false)}
          preferredWidth={188}
        >
          <div className="preference-menu" role="menu">
            {LANGUAGE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={currentLanguage === option.value}
                className={clsx("preference-menu-item", {
                  active: currentLanguage === option.value,
                })}
                onClick={() => {
                  void setAppLanguage(option.value);
                  setShowLanguageMenu(false);
                }}
              >
                <span className="language-menu-code">{option.code}</span>
                <span>{option.label}</span>
                {currentLanguage === option.value && (
                  <Check className="preference-menu-check" size={15} />
                )}
              </button>
            ))}
          </div>
        </AnchoredPopover>
      )}

      <button
        ref={themeButtonRef}
        type="button"
        className={clsx(
          "icon-button window-titlebar-action-button titlebar-utility-button",
          { active: showThemeMenu },
        )}
        title={t("theme.current", { mode: t(currentTheme.labelKey) })}
        aria-label={t("theme.current", { mode: t(currentTheme.labelKey) })}
        aria-haspopup="menu"
        aria-expanded={showThemeMenu}
        onClick={() => {
          setShowLanguageMenu(false);
          setShowThemeMenu((value) => !value);
        }}
      >
        <CurrentThemeIcon size={18} />
      </button>
      {showThemeMenu && (
        <AnchoredPopover
          anchorRef={themeButtonRef}
          ariaLabel={t("theme.select")}
          className="preference-popover"
          onClose={() => setShowThemeMenu(false)}
          preferredWidth={188}
        >
          <div className="preference-menu" role="menu">
            {THEME_OPTIONS.map((option) => {
              const ThemeIcon = option.icon;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={themeMode === option.value}
                  className={clsx("preference-menu-item", {
                    active: themeMode === option.value,
                  })}
                  onClick={() => {
                    setThemeMode(option.value);
                    setShowThemeMenu(false);
                  }}
                >
                  <ThemeIcon size={16} />
                  <span>{t(option.labelKey)}</span>
                  {themeMode === option.value && (
                    <Check className="preference-menu-check" size={15} />
                  )}
                </button>
              );
            })}
          </div>
        </AnchoredPopover>
      )}

      <button
        type="button"
        className={clsx(
          "icon-button window-titlebar-action-button titlebar-utility-button nav-item",
          { active: view === "executions" },
        )}
        title={t("sidebar.executions")}
        aria-label={t("sidebar.executions")}
        onClick={() => setView("executions")}
      >
        <SquareTerminal size={16} />
        {activeCount > 0 && (
          <span
            className="nav-count"
            aria-label={t("sidebar.activeTasks", { count: activeCount })}
          >
            {activeCount}
          </span>
        )}
      </button>
      <button
        type="button"
        className={clsx(
          "icon-button window-titlebar-action-button titlebar-utility-button nav-item",
          { active: view === "settings" },
        )}
        title={t("sidebar.settings")}
        aria-label={t("sidebar.settings")}
        onClick={() => setView("settings")}
      >
        <Settings size={16} />
      </button>
      <button
        type="button"
        className={clsx(
          "icon-button window-titlebar-action-button titlebar-utility-button nav-item",
          { active: view === "about" },
        )}
        title={t("sidebar.about")}
        aria-label={t("sidebar.about")}
        onClick={() => setView("about")}
      >
        <Info size={16} />
      </button>
    </div>
  );
}

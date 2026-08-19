import {
  Check,
  FolderKanban,
  Info,
  Monitor,
  Moon,
  Settings,
  SquareTerminal,
  Sun,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import clsx from "clsx";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  isExecutionActive,
  useExecutionTasks,
} from "../hooks/useExecutionTasks";
import { getAppLanguage, setAppLanguage, type AppLanguage } from "../i18n";
import { useAppStore, type ThemeMode } from "../store/appStore";
import githubIcon from "../assets/icons/brands/github.svg";
import { AnchoredPopover } from "./AnchoredPopover";
import { AppLogo } from "./AppLogo";
import { SvgAssetIcon } from "./SvgAssetIcon";

const REPOSITORY_URL = "https://github.com/SkyJourney/cli-launchpad";

const THEME_OPTIONS: {
  icon: LucideIcon;
  labelKey: "theme.light" | "theme.dark" | "theme.system";
  value: ThemeMode;
}[] = [
  { icon: Sun, labelKey: "theme.light", value: "light" },
  { icon: Moon, labelKey: "theme.dark", value: "dark" },
  { icon: Monitor, labelKey: "theme.system", value: "system" },
];

const LANGUAGE_OPTIONS: {
  code: "ZH" | "EN";
  labelKey: "language.zh" | "language.en";
  value: AppLanguage;
}[] = [
  { code: "ZH", labelKey: "language.zh", value: "zh" },
  { code: "EN", labelKey: "language.en", value: "en" },
];

export function Sidebar() {
  const { t } = useTranslation();
  const view = useAppStore((state) => state.view);
  const setView = useAppStore((state) => state.setView);
  const themeMode = useAppStore((state) => state.themeMode);
  const setThemeMode = useAppStore((state) => state.setThemeMode);
  const [showThemeMenu, setShowThemeMenu] = useState(false);
  const [showLanguageMenu, setShowLanguageMenu] = useState(false);
  const themeButtonRef = useRef<HTMLButtonElement | null>(null);
  const languageButtonRef = useRef<HTMLButtonElement | null>(null);
  const tasks = useExecutionTasks();
  const activeCount =
    tasks.data?.filter((task) => isExecutionActive(task.status)).length ?? 0;

  const onProjects =
    view === "projects" || view === "detail" || view === "edit";
  const currentTheme =
    THEME_OPTIONS.find((option) => option.value === themeMode) ??
    THEME_OPTIONS[2];
  const CurrentThemeIcon = currentTheme.icon;
  const currentLanguage = getAppLanguage();
  const currentLanguageOption =
    LANGUAGE_OPTIONS.find((option) => option.value === currentLanguage) ??
    LANGUAGE_OPTIONS[1];

  return (
    <aside className="sidebar">
      <div className="brand">
        <AppLogo size={32} />
        <span>CLI Launchpad</span>
      </div>

      <nav className="sidebar-nav">
        <button
          className={clsx("nav-item", { active: onProjects })}
          onClick={() => setView("projects")}
        >
          <FolderKanban size={16} />
          {t("sidebar.projects")}
        </button>
        <button
          className={clsx("nav-item", { active: view === "executions" })}
          onClick={() => setView("executions")}
        >
          <SquareTerminal size={16} />
          <span>{t("sidebar.executions")}</span>
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
          className={clsx("nav-item", { active: view === "settings" })}
          onClick={() => setView("settings")}
        >
          <Settings size={16} />
          {t("sidebar.settings")}
        </button>
        <button
          className={clsx("nav-item", { active: view === "about" })}
          onClick={() => setView("about")}
        >
          <Info size={16} />
          {t("sidebar.about")}
        </button>
      </nav>

      <div className="sidebar-footer">
        <button
          ref={languageButtonRef}
          type="button"
          className={clsx("icon-button sidebar-language-button", {
            active: showLanguageMenu,
          })}
          title={t("language.current", {
            language: t(currentLanguageOption.labelKey),
          })}
          aria-label={t("language.current", {
            language: t(currentLanguageOption.labelKey),
          })}
          aria-haspopup="menu"
          aria-expanded={showLanguageMenu}
          onClick={() => {
            setShowThemeMenu(false);
            setShowLanguageMenu((value) => !value);
          }}
        >
          <span className="sidebar-language-code">
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
                  <span>{t(option.labelKey)}</span>
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
          className={clsx("icon-button sidebar-theme-button", {
            active: showThemeMenu,
          })}
          title={t("theme.current", {
            mode: t(currentTheme.labelKey),
          })}
          aria-label={t("theme.current", {
            mode: t(currentTheme.labelKey),
          })}
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
          className="icon-button sidebar-repository-button"
          title={t("sidebar.openRepository")}
          aria-label={t("sidebar.openRepository")}
          onClick={() => {
            void openUrl(REPOSITORY_URL).catch((error: unknown) => {
              console.error(t("sidebar.openRepositoryError"), error);
              window.alert(t("sidebar.openRepositoryError"));
            });
          }}
        >
          <SvgAssetIcon src={githubIcon} size={20} monochrome />
        </button>
      </div>
    </aside>
  );
}

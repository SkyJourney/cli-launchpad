import {
  Check,
  Ellipsis,
  FolderKanban,
  FolderOpen,
  Info,
  Monitor,
  Moon,
  Plus,
  Pin,
  PinOff,
  Pencil,
  Settings,
  SquareTerminal,
  Sun,
  Trash2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import clsx from "clsx";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type UIEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  isExecutionActive,
  useExecutionTasks,
} from "../hooks/useExecutionTasks";
import { getAppLanguage, setAppLanguage, type AppLanguage } from "../i18n";
import { useAppStore, type ThemeMode } from "../store/appStore";
import { useDirectories } from "../hooks/queries";
import { qk } from "../lib/queryKeys";
import { listWorkspacePanes } from "../lib/ptyWorkspaceLayout";
import {
  openProjectDirectory,
  removeDirectory,
  setDirectoryPinned,
  type Directory,
} from "../lib/tauri";
import { TOOLS } from "../lib/tools";
import { AnchoredPopover } from "./AnchoredPopover";
import { usePtyWorkspace } from "./PtyWorkspace";
import { SearchInput } from "./SearchInput";

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
  const openDirectory = useAppStore((state) => state.openDirectory);
  const selectDirectory = useAppStore((state) => state.selectDirectory);
  const setProjectDialog = useAppStore((state) => state.setProjectDialog);
  const selectedDirectoryId = useAppStore((state) => state.selectedDirectoryId);
  const ptySessionsById = useAppStore((state) => state.ptySessionsById);
  const { slots, tree, detachedInstanceIds, hydrationStatus } =
    usePtyWorkspace();
  const queryClient = useQueryClient();
  const { data: directories } = useDirectories();
  const [showThemeMenu, setShowThemeMenu] = useState(false);
  const [showLanguageMenu, setShowLanguageMenu] = useState(false);
  const [projectMenuDirectoryId, setProjectMenuDirectoryId] = useState<
    number | null
  >(null);
  const [projectSearch, setProjectSearch] = useState("");
  const themeButtonRef = useRef<HTMLButtonElement | null>(null);
  const languageButtonRef = useRef<HTMLButtonElement | null>(null);
  const projectMenuAnchors = useRef(new Map<number, HTMLButtonElement>());
  const projectNavigationListRef = useRef<HTMLDivElement | null>(null);
  const projectScrollbarTrackRef = useRef<HTMLDivElement | null>(null);
  const projectScrollbarThumbRef = useRef<HTMLDivElement | null>(null);
  const projectScrollTimeout = useRef<number | null>(null);
  const projectScrollbarDrag = useRef<{
    pointerId: number;
    startY: number;
    startScrollTop: number;
    scrollRange: number;
    thumbTravel: number;
  } | null>(null);
  const [projectScrollbarVisible, setProjectScrollbarVisible] = useState(false);
  useEffect(
    () => () => {
      if (projectScrollTimeout.current !== null) {
        window.clearTimeout(projectScrollTimeout.current);
      }
    },
    [],
  );
  const updateProjectScrollbar = (list: HTMLDivElement) => {
    const track = projectScrollbarTrackRef.current;
    const thumb = projectScrollbarThumbRef.current;
    if (!track || !thumb) return;

    const scrollRange = list.scrollHeight - list.clientHeight;
    const trackHeight = track.clientHeight;
    if (scrollRange <= 0 || trackHeight <= 0) {
      thumb.style.display = "none";
      return;
    }

    const thumbHeight = Math.min(
      trackHeight,
      Math.max(24, (list.clientHeight / list.scrollHeight) * trackHeight),
    );
    const thumbTravel = trackHeight - thumbHeight;
    const thumbTop = (list.scrollTop / scrollRange) * thumbTravel;
    thumb.style.display = "block";
    thumb.style.height = `${thumbHeight}px`;
    thumb.style.transform = `translateY(${thumbTop}px)`;
  };
  const handleProjectNavigationScroll = (event: UIEvent<HTMLDivElement>) => {
    const list = event.currentTarget;
    updateProjectScrollbar(list);
    setProjectScrollbarVisible(true);
    if (projectScrollTimeout.current !== null) {
      window.clearTimeout(projectScrollTimeout.current);
    }
    projectScrollTimeout.current = window.setTimeout(() => {
      setProjectScrollbarVisible(false);
      projectScrollTimeout.current = null;
    }, 750);
  };
  const handleProjectScrollbarTrackPointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    const list = projectNavigationListRef.current;
    const track = event.currentTarget;
    const thumb = projectScrollbarThumbRef.current;
    if (!list || !thumb) return;

    event.preventDefault();
    const trackRect = track.getBoundingClientRect();
    const thumbTop = thumb.getBoundingClientRect().top - trackRect.top;
    const pointerTop = event.clientY - trackRect.top;
    list.scrollTop +=
      pointerTop < thumbTop ? -list.clientHeight : list.clientHeight;
  };
  const handleProjectScrollbarThumbPointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    const list = projectNavigationListRef.current;
    const track = projectScrollbarTrackRef.current;
    const thumb = event.currentTarget;
    if (!list || !track) return;

    event.preventDefault();
    event.stopPropagation();
    projectScrollbarDrag.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startScrollTop: list.scrollTop,
      scrollRange: list.scrollHeight - list.clientHeight,
      thumbTravel: track.clientHeight - thumb.clientHeight,
    };
    thumb.setPointerCapture(event.pointerId);
  };
  const handleProjectScrollbarThumbPointerMove = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    const drag = projectScrollbarDrag.current;
    const list = projectNavigationListRef.current;
    if (
      !drag ||
      drag.pointerId !== event.pointerId ||
      !list ||
      drag.thumbTravel <= 0
    ) {
      return;
    }

    list.scrollTop =
      drag.startScrollTop +
      ((event.clientY - drag.startY) / drag.thumbTravel) * drag.scrollRange;
  };
  const handleProjectScrollbarThumbPointerEnd = () => {
    projectScrollbarDrag.current = null;
  };
  const tasks = useExecutionTasks();
  const pinMutation = useMutation({
    mutationFn: ({ id, pinned }: { id: number; pinned: boolean }) =>
      setDirectoryPinned(id, pinned),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: qk.directories() }),
  });
  const removeMutation = useMutation({
    mutationFn: removeDirectory,
    onSuccess: async (_, removedId) => {
      await queryClient.invalidateQueries({ queryKey: qk.directories() });
      setProjectMenuDirectoryId(null);
      if (selectedDirectoryId === removedId) {
        selectDirectory(null);
        if (view === "detail") setView("projects");
      }
    },
  });
  const activeCount =
    tasks.data?.filter((task) => isExecutionActive(task.status)).length ?? 0;
  const workspaceSessionIds = useMemo(() => {
    if (hydrationStatus !== "ready") return new Set<string>();
    const representedInstanceIds = new Set([
      ...listWorkspacePanes(tree).flatMap((pane) => pane.sessionIds),
      ...detachedInstanceIds,
    ]);
    return new Set(
      slots
        .filter((slot) => representedInstanceIds.has(slot.instanceId))
        .map((slot) => slot.sessionId)
        .filter((sessionId): sessionId is string => Boolean(sessionId)),
    );
  }, [detachedInstanceIds, hydrationStatus, slots, tree]);

  const onProjects = view === "projects" || view === "detail";
  const visibleDirectories = useMemo(() => {
    const term = projectSearch.trim().toLocaleLowerCase();
    return [...(directories ?? [])]
      .filter(
        (directory) =>
          !term || directory.name.toLocaleLowerCase().includes(term),
      )
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? "");
      });
  }, [directories, projectSearch]);
  const currentTheme =
    THEME_OPTIONS.find((option) => option.value === themeMode) ??
    THEME_OPTIONS[2];
  const CurrentThemeIcon = currentTheme.icon;
  const currentLanguage = getAppLanguage();
  const currentLanguageOption =
    LANGUAGE_OPTIONS.find((option) => option.value === currentLanguage) ??
    LANGUAGE_OPTIONS[1];
  const projectMenuAnchorRef = useMemo(
    () => ({
      current:
        projectMenuDirectoryId == null
          ? null
          : (projectMenuAnchors.current.get(projectMenuDirectoryId) ?? null),
    }),
    [projectMenuDirectoryId],
  );
  const menuDirectory = directories?.find(
    (directory) => directory.id === projectMenuDirectoryId,
  );

  const openDirectoryMenuAction = async (directory: Directory) => {
    setProjectMenuDirectoryId(null);
    try {
      await openProjectDirectory(directory.id);
    } catch (error) {
      toast.error(
        t("sidebar.openProjectFolderFailed", { error: String(error) }),
      );
    }
  };

  const removeProject = (directory: Directory) => {
    if (
      !window.confirm(
        t("sidebar.confirmRemoveProject", { name: directory.name }),
      )
    ) {
      return;
    }
    removeMutation.mutate(directory.id, {
      onError: (error) =>
        toast.error(t("sidebar.removeProjectFailed", { error: String(error) })),
    });
  };

  return (
    <aside className="sidebar">
      <section
        className="project-navigation"
        aria-label={t("sidebar.projects")}
      >
        <div className="project-navigation-heading">
          <button
            className={clsx("project-navigation-title", {
              active: onProjects,
            })}
            onClick={() => setView("projects")}
          >
            <FolderKanban size={16} />
            <span>{t("sidebar.projects")}</span>
          </button>
          <button
            type="button"
            className="icon-button project-add-button"
            title={t("sidebar.addProject")}
            aria-label={t("sidebar.addProject")}
            onClick={() => setProjectDialog({ mode: "add" })}
          >
            <Plus size={16} />
          </button>
        </div>
        <SearchInput
          value={projectSearch}
          onChange={setProjectSearch}
          placeholder={t("sidebar.searchProjects")}
          ariaLabel={t("sidebar.searchProjects")}
        />
        <div className="project-navigation-scroll-area">
          <div
            id="project-navigation-list"
            ref={projectNavigationListRef}
            className="project-navigation-list"
            onScroll={handleProjectNavigationScroll}
            role="region"
            aria-label={t("sidebar.projects")}
            tabIndex={0}
          >
            {visibleDirectories.map((directory) => {
              const selected =
                selectedDirectoryId === directory.id && view === "detail";
              const projectSessions = Object.values(ptySessionsById).filter(
                (session) =>
                  session.directoryId === directory.id &&
                  session.state === "running" &&
                  workspaceSessionIds.has(session.sessionId),
              );
              const projectCliSessions = TOOLS.flatMap((tool) => {
                const count = projectSessions.filter(
                  (session) => session.toolKey === tool.key,
                ).length;
                return count > 0 ? [{ tool, count }] : [];
              });
              return (
                <div
                  className="project-navigation-entry"
                  key={directory.id}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setProjectMenuDirectoryId(directory.id);
                  }}
                >
                  <div className="project-navigation-row">
                    <button
                      type="button"
                      className={clsx("project-navigation-item", {
                        active: selected,
                        pinned: directory.pinned,
                      })}
                      title={directory.name}
                      aria-current={selected ? "page" : undefined}
                      onClick={() => openDirectory(directory.id)}
                    >
                      <span className="project-navigation-name">
                        {directory.name}
                      </span>
                    </button>
                    <button
                      ref={(element) => {
                        if (element) {
                          projectMenuAnchors.current.set(directory.id, element);
                        } else projectMenuAnchors.current.delete(directory.id);
                      }}
                      type="button"
                      className={clsx(
                        "icon-button project-navigation-menu-button",
                        { active: projectMenuDirectoryId === directory.id },
                      )}
                      title={t("sidebar.projectActions", {
                        name: directory.name,
                      })}
                      aria-label={t("sidebar.projectActions", {
                        name: directory.name,
                      })}
                      aria-haspopup="menu"
                      aria-expanded={projectMenuDirectoryId === directory.id}
                      onClick={() =>
                        setProjectMenuDirectoryId((current) =>
                          current === directory.id ? null : directory.id,
                        )
                      }
                    >
                      <Ellipsis size={17} />
                    </button>
                  </div>
                  {projectCliSessions.length > 0 && (
                    <ul className="project-navigation-session-list">
                      {projectCliSessions.map(({ tool, count }) => {
                        const ToolIcon = tool.icon;
                        const label = t("sidebar.managedCliSessions", {
                          tool: tool.label,
                          count,
                        });
                        return (
                          <li
                            className="project-navigation-session-item"
                            key={tool.key}
                            aria-label={label}
                            title={label}
                          >
                            <ToolIcon size={14} />
                            <span className="project-navigation-session-name">
                              {tool.label}
                            </span>
                            <span className="project-navigation-session-count">
                              {count}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              );
            })}
            {visibleDirectories.length === 0 && (
              <p className="project-navigation-empty">
                {projectSearch.trim()
                  ? t("sidebar.noMatchingProjects")
                  : t("sidebar.noProjects")}
              </p>
            )}
          </div>
          <div
            ref={projectScrollbarTrackRef}
            className={clsx("project-navigation-scrollbar", {
              visible: projectScrollbarVisible,
            })}
            aria-hidden="true"
            onPointerDown={handleProjectScrollbarTrackPointerDown}
          >
            <div
              ref={projectScrollbarThumbRef}
              className="project-navigation-scrollbar-thumb"
              onPointerDown={handleProjectScrollbarThumbPointerDown}
              onPointerMove={handleProjectScrollbarThumbPointerMove}
              onPointerUp={handleProjectScrollbarThumbPointerEnd}
              onPointerCancel={handleProjectScrollbarThumbPointerEnd}
            />
          </div>
        </div>
      </section>

      {menuDirectory && (
        <AnchoredPopover
          anchorRef={projectMenuAnchorRef}
          ariaLabel={t("sidebar.projectActions", { name: menuDirectory.name })}
          className="project-row-menu-popover"
          onClose={() => setProjectMenuDirectoryId(null)}
          preferredWidth={204}
        >
          <div className="project-row-menu" role="menu">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setProjectMenuDirectoryId(null);
                setProjectDialog({
                  mode: "edit",
                  directoryId: menuDirectory.id,
                });
              }}
            >
              <Pencil size={15} />
              <span>{t("sidebar.renameProject")}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={pinMutation.isPending}
              onClick={() => {
                const pinned = !menuDirectory.pinned;
                setProjectMenuDirectoryId(null);
                pinMutation.mutate(
                  { id: menuDirectory.id, pinned },
                  {
                    onError: (error) =>
                      toast.error(
                        t("sidebar.pinProjectFailed", {
                          error: String(error),
                        }),
                      ),
                  },
                );
              }}
            >
              {menuDirectory.pinned ? <PinOff size={15} /> : <Pin size={15} />}
              <span>
                {menuDirectory.pinned
                  ? t("sidebar.unpinProject")
                  : t("sidebar.pinProject")}
              </span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => void openDirectoryMenuAction(menuDirectory)}
            >
              <FolderOpen size={15} />
              <span>{t("sidebar.openProjectFolder")}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="danger"
              disabled={removeMutation.isPending}
              onClick={() => removeProject(menuDirectory)}
            >
              <Trash2 size={15} />
              <span>{t("sidebar.removeProject")}</span>
            </button>
          </div>
        </AnchoredPopover>
      )}

      <div className="sidebar-actions">
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
          className={clsx("icon-button nav-item", {
            active: view === "executions",
          })}
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
          className={clsx("icon-button nav-item", {
            active: view === "settings",
          })}
          title={t("sidebar.settings")}
          aria-label={t("sidebar.settings")}
          onClick={() => setView("settings")}
        >
          <Settings size={16} />
        </button>
        <button
          className={clsx("icon-button nav-item", {
            active: view === "about",
          })}
          title={t("sidebar.about")}
          aria-label={t("sidebar.about")}
          onClick={() => setView("about")}
        >
          <Info size={16} />
        </button>
      </div>
    </aside>
  );
}

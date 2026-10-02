import {
  Ellipsis,
  FolderKanban,
  FolderOpen,
  Plus,
  Pin,
  PinOff,
  Pencil,
  Trash2,
} from "lucide-react";
import clsx from "clsx";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useAppStore } from "../store/appStore";
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
import { ThemedScrollArea } from "./ThemedScrollArea";

export function Sidebar({ hidden = false }: { hidden?: boolean }) {
  const { t } = useTranslation();
  const view = useAppStore((state) => state.view);
  const setView = useAppStore((state) => state.setView);
  const openDirectory = useAppStore((state) => state.openDirectory);
  const selectDirectory = useAppStore((state) => state.selectDirectory);
  const setProjectDialog = useAppStore((state) => state.setProjectDialog);
  const selectedDirectoryId = useAppStore((state) => state.selectedDirectoryId);
  const ptySessionsById = useAppStore((state) => state.ptySessionsById);
  const { slots, tree, detachedInstanceIds, hydrationStatus } =
    usePtyWorkspace();
  const queryClient = useQueryClient();
  const { data: directories } = useDirectories();
  const [projectMenuDirectoryId, setProjectMenuDirectoryId] = useState<
    number | null
  >(null);
  const [projectSearch, setProjectSearch] = useState("");
  const projectMenuAnchors = useRef(new Map<number, HTMLButtonElement>());
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
    <aside id="app-sidebar" className="sidebar" hidden={hidden}>
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
        <ThemedScrollArea
          className="project-navigation-scroll-area"
          viewportClassName="project-navigation-list"
          viewportProps={{
            id: "project-navigation-list",
            role: "region",
            "aria-label": t("sidebar.projects"),
            tabIndex: 0,
          }}
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
        </ThemedScrollArea>
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
    </aside>
  );
}

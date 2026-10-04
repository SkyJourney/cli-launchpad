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
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useAppStore } from "../store/appStore";
import { useDirectories } from "../hooks/queries";
import { qk } from "../lib/queryKeys";
import { moveProjectWithinPinGroup } from "../lib/projectOrdering";
import { listWorkspacePaneContents, listWorkspacePanes } from "../lib/ptyWorkspaceLayout";
import {
  openProjectDirectory,
  removeDirectory,
  reorderDirectories,
  setDirectoryPinned,
  type Directory,
} from "../lib/tauri";
import { TOOLS, type ToolMeta } from "../lib/tools";
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
  const [draggedProjectId, setDraggedProjectId] = useState<number | null>(null);
  const [projectDropTarget, setProjectDropTarget] = useState<{
    id: number;
    position: "before" | "after";
  } | null>(null);
  const projectMenuAnchors = useRef(new Map<number, HTMLButtonElement>());
  const reorderMutation = useMutation({
    mutationFn: ({
      orderedIds,
      pinned,
    }: {
      orderedIds: number[];
      pinned: boolean;
    }) => reorderDirectories(orderedIds, pinned),
    onMutate: async ({ orderedIds, pinned }) => {
      await queryClient.cancelQueries({ queryKey: qk.directories() });
      const previousDirectories = queryClient.getQueryData<Directory[]>(
        qk.directories(),
      );
      if (previousDirectories) {
        const sortOrder = new Map(orderedIds.map((id, index) => [id, index]));
        queryClient.setQueryData<Directory[]>(
          qk.directories(),
          previousDirectories.map((directory) =>
            directory.pinned === pinned && sortOrder.has(directory.id)
              ? { ...directory, sortOrder: sortOrder.get(directory.id)! }
              : directory,
          ),
        );
      }
      return { previousDirectories };
    },
    onError: (error, _variables, context) => {
      if (context?.previousDirectories) {
        queryClient.setQueryData(qk.directories(), context.previousDirectories);
      }
      toast.error(t("sidebar.reorderProjectsFailed", { error: String(error) }));
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: qk.directories() }),
  });
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
      ...listWorkspacePanes(tree).flatMap((pane) =>
        listWorkspacePaneContents(pane, "pty").flatMap((content) =>
          content.kind === "pty" ? [content.slotId] : [],
        ),
      ),
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
        return (
          a.sortOrder - b.sortOrder ||
          (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? "") ||
          a.name.localeCompare(b.name)
        );
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

  const clearProjectDragState = () => {
    setDraggedProjectId(null);
    setProjectDropTarget(null);
  };

  const dropProject = (
    targetId: number,
    event: React.DragEvent<HTMLDivElement>,
  ) => {
    event.preventDefault();
    const sourceId = Number(event.dataTransfer.getData("text/plain"));
    if (!Number.isSafeInteger(sourceId) || !directories) {
      clearProjectDragState();
      return;
    }
    const position =
      projectDropTarget?.id === targetId ? projectDropTarget.position : "after";
    const source = directories.find((directory) => directory.id === sourceId);
    const orderedIds = moveProjectWithinPinGroup(
      directories,
      sourceId,
      targetId,
      position,
    );
    if (source && orderedIds) {
      reorderMutation.mutate({ orderedIds, pinned: source.pinned });
    }
    clearProjectDragState();
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
                className={clsx("project-navigation-entry", {
                  dragging: draggedProjectId === directory.id,
                  "drop-before":
                    projectDropTarget?.id === directory.id &&
                    projectDropTarget.position === "before",
                  "drop-after":
                    projectDropTarget?.id === directory.id &&
                    projectDropTarget.position === "after",
                })}
                key={directory.id}
                draggable={
                  !projectSearch.trim() && visibleDirectories.length > 1
                }
                onDragStart={(event) => {
                  if (projectSearch.trim()) {
                    event.preventDefault();
                    return;
                  }
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData(
                    "text/plain",
                    String(directory.id),
                  );
                  setDraggedProjectId(directory.id);
                }}
                onDragOver={(event) => {
                  if (!draggedProjectId || draggedProjectId === directory.id)
                    return;
                  const dragged = directories?.find(
                    (candidate) => candidate.id === draggedProjectId,
                  );
                  if (!dragged || dragged.pinned !== directory.pinned) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  const bounds = event.currentTarget.getBoundingClientRect();
                  const position =
                    event.clientY < bounds.top + bounds.height / 2
                      ? "before"
                      : "after";
                  setProjectDropTarget((current) =>
                    current?.id === directory.id &&
                    current.position === position
                      ? current
                      : { id: directory.id, position },
                  );
                }}
                onDrop={(event) => dropProject(directory.id, event)}
                onDragEnd={clearProjectDragState}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setProjectMenuDirectoryId(directory.id);
                }}
              >
                <div
                  className={clsx("project-navigation-row", {
                    active: selected,
                    pinned: directory.pinned,
                  })}
                >
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
                <ProjectNavigationSessions sessions={projectCliSessions} />
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

type ProjectCliSession = { tool: ToolMeta; count: number };
type AnimatedProjectCliSession = ProjectCliSession & {
  phase: "entering" | "steady" | "exiting";
};

function ProjectNavigationSessions({
  sessions,
}: {
  sessions: ProjectCliSession[];
}) {
  const { t } = useTranslation();
  const [renderedSessions, setRenderedSessions] = useState<
    AnimatedProjectCliSession[]
  >(() =>
    sessions.map((session) => ({ ...session, phase: "steady" as const })),
  );

  useEffect(() => {
    setRenderedSessions((current) => {
      const desired = new Map(
        sessions.map((session) => [session.tool.key, session]),
      );
      const next = current.map((session) => {
        const updated = desired.get(session.tool.key);
        if (!updated) {
          return session.phase === "exiting"
            ? session
            : { ...session, phase: "exiting" as const };
        }

        desired.delete(session.tool.key);
        return {
          ...updated,
          phase:
            session.phase === "exiting" ? ("entering" as const) : session.phase,
        };
      });

      for (const session of desired.values()) {
        next.push({ ...session, phase: "entering" });
      }

      if (
        next.length === current.length &&
        next.every(
          (session, index) =>
            session.tool.key === current[index].tool.key &&
            session.count === current[index].count &&
            session.phase === current[index].phase,
        )
      ) {
        return current;
      }
      return next;
    });
  }, [sessions]);

  const panelStyle = {
    "--project-session-panel-height":
      sessions.length > 0 ? String(sessions.length * 23 + 5) + "px" : "0px",
  } as CSSProperties;

  const handleAnimationEnd = (
    toolKey: ToolMeta["key"],
    phase: AnimatedProjectCliSession["phase"],
  ) => {
    if (phase === "exiting") {
      setRenderedSessions((current) =>
        current.filter((session) => session.tool.key !== toolKey),
      );
      return;
    }
    if (phase === "entering") {
      setRenderedSessions((current) =>
        current.map((session) =>
          session.tool.key === toolKey && session.phase === "entering"
            ? { ...session, phase: "steady" }
            : session,
        ),
      );
    }
  };

  return (
    <div
      className={clsx("project-navigation-session-panel", {
        expanded: sessions.length > 0,
      })}
      style={panelStyle}
      aria-hidden={sessions.length === 0}
    >
      <ul className="project-navigation-session-list">
        {renderedSessions.map(({ tool, count, phase }) => {
          const ToolIcon = tool.icon;
          const label = t("sidebar.managedCliSessions", {
            tool: tool.label,
            count,
          });
          return (
            <li
              className={clsx("project-navigation-session-item", {
                entering: phase === "entering",
                exiting: phase === "exiting",
              })}
              key={tool.key}
              aria-label={label}
              aria-hidden={phase === "exiting"}
              title={label}
              onAnimationEnd={() => handleAnimationEnd(tool.key, phase)}
            >
              <ToolIcon size={14} />
              <span className="project-navigation-session-name">
                {tool.label}
              </span>
              <span className="project-navigation-session-count">{count}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

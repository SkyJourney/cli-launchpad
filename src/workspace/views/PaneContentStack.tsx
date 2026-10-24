import clsx from "clsx";
import { ChevronDown, Layers, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type WorkspaceFileDocument, type PtySession } from "../../lib/tauri";
import { workspaceContentKey } from "../../lib/workspaceContentKey";
import { AnchoredPopover } from "../../components/AnchoredPopover";
import {
  presentWorkspaceContent,
  tryGetWorkspaceContentAdapter,
  type WorkspaceContentPresentationContext,
} from "../../components/WorkspaceContentView";
import type { WorkspaceFileBuffer } from "../../lib/workspaceFileBuffer";
import { type PtyWorkspaceSlot } from "../../components/WorkspacePtySessionRegistry";
import { beginWorkspaceContentDrag } from "./viewHelpers";
import type { ResolvedPaneContent } from "./WorkspacePaneView";

export function PaneContentStack({
  side,
  sourcePaneId,
  entries,
  directories,
  ptySlots,
  ptySessionsById,
  fileDocuments,
  fileBuffers,
  selectedDirectoryId,
  closingContentKeys,
  onActivate,
  onCloseContent,
  onContextMenu,
}: {
  side: "before" | "after" | "overflow";
  sourcePaneId: string;
  entries: ResolvedPaneContent[];
  directories: { id: number; name: string }[];
  ptySlots: PtyWorkspaceSlot[];
  ptySessionsById: Record<string, PtySession>;
  fileDocuments: WorkspaceFileDocument[];
  fileBuffers: Record<string, WorkspaceFileBuffer | undefined>;
  selectedDirectoryId: number | null;
  closingContentKeys: Set<string>;
  onActivate: (entry: ResolvedPaneContent) => void;
  onCloseContent: (entry: ResolvedPaneContent) => void;
  onContextMenu: (entry: ResolvedPaneContent, x: number, y: number) => void;
}) {
  const { t } = useTranslation();
  const presentationContext: WorkspaceContentPresentationContext = {
    directories,
    ptySlots,
    ptySessionsById,
    fileDocuments,
    fileBuffers,
    selectedDirectoryId,
  };
  const anchorRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const label = t(
    side === "before"
      ? "pty.previousSessions"
      : side === "after"
        ? "pty.nextSessions"
        : "pty.overflowContents",
    { count: entries.length },
  );
  const heading = t(
    side === "before"
      ? "pty.previousSessionsHeading"
      : side === "after"
        ? "pty.nextSessionsHeading"
        : "pty.overflowContentsHeading",
  );

  useEffect(() => {
    if (!open) return;
    const boundedIndex = Math.min(focusedIndex, entries.length - 1);
    setFocusedIndex(Math.max(0, boundedIndex));
    listRef.current
      ?.querySelector<HTMLButtonElement>(
        `[data-stack-index="${Math.max(0, boundedIndex)}"]`,
      )
      ?.focus();
  }, [entries.length, focusedIndex, open]);

  const focusStackEntry = (index: number) => {
    if (entries.length === 0) return;
    const nextIndex = (index + entries.length) % entries.length;
    setFocusedIndex(nextIndex);
    listRef.current
      ?.querySelector<HTMLButtonElement>(`[data-stack-index="${nextIndex}"]`)
      ?.focus();
  };

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="pty-pane-stack-trigger"
        title={label}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        <Layers size={14} aria-hidden="true" />
        <span>{entries.length}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open && (
        <AnchoredPopover
          anchorRef={anchorRef}
          ariaLabel={heading}
          className="pty-pane-session-stack-popover"
          onClose={() => setOpen(false)}
          preferredWidth={320}
        >
          <div
            ref={listRef}
            className="pty-pane-session-stack-list"
            aria-label={heading}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                focusStackEntry(focusedIndex + 1);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                focusStackEntry(focusedIndex - 1);
              } else if (event.key === "Delete") {
                event.preventDefault();
                onCloseContent(entries[focusedIndex]);
              }
            }}
          >
            {entries.map((entry, index) => {
              const presentation = presentWorkspaceContent(
                entry.content,
                presentationContext,
              );
              const title = presentation.title;
              const contentKey = workspaceContentKey(entry.content);
              const isClosing = closingContentKeys.has(contentKey);
              const closeLabel = t(presentation.closeLabelKey);
              const adapter =
                entry.content.kind === "unknown"
                  ? undefined
                  : tryGetWorkspaceContentAdapter(entry.content.kind);
              const closeAccessibleName = adapter
                ? t(adapter.labels.closeCurrent, { name: title })
                : t("workspaceContent.closeUnsupported");

              return (
                <div
                  className="pty-pane-session-stack-entry"
                  key={contentKey}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setOpen(false);
                    if (
                      entry.content.kind === "unknown" ||
                      isClosing ||
                      !adapter
                    )
                      return;
                    onContextMenu(entry, event.clientX, event.clientY);
                  }}
                >
                  <button
                    type="button"
                    className="pty-pane-session-stack-session"
                    title={title}
                    aria-label={title}
                    data-stack-index={index}
                    tabIndex={index === focusedIndex ? 0 : -1}
                    draggable={
                      entry.content.kind !== "unknown" &&
                      !isClosing &&
                      !!adapter
                    }
                    onFocus={() => setFocusedIndex(index)}
                    onDragStart={(event) => {
                      if (isClosing || entry.content.kind === "unknown") return;
                      beginWorkspaceContentDrag(
                        event,
                        sourcePaneId,
                        workspaceContentKey(entry.content),
                      );
                    }}
                    onDragEnd={() => setOpen(false)}
                    onClick={() => {
                      setOpen(false);
                      onActivate(entry);
                    }}
                  >
                    {presentation.icon}
                    {isClosing ? (
                      <span
                        className="pty-pane-tab-status terminating"
                        title={t("pty.terminating")}
                        aria-label={t("pty.terminating")}
                      />
                    ) : presentation.status ? (
                      <span
                        className={clsx("pty-pane-tab-status", {
                          running: presentation.status === "running",
                          failed: presentation.status === "failed",
                          dirty: presentation.status === "dirty",
                        })}
                        aria-hidden="true"
                      />
                    ) : null}
                    <span>{title}</span>
                  </button>
                  <button
                    type="button"
                    className="pty-pane-session-stack-close"
                    title={closeLabel}
                    aria-label={closeAccessibleName}
                    onClick={() => onCloseContent(entry)}
                  >
                    <X size={13} />
                  </button>
                </div>
              );
            })}
          </div>
        </AnchoredPopover>
      )}
    </>
  );
}

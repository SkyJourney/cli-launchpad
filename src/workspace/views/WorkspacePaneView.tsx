import clsx from "clsx";
import { Columns2, Rows2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { emitWorkspaceContentWindowEvent } from "../../lib/workspaceContentWindowProtocol";
import {
  type WorkspaceNode,
  canSplitWorkspacePane,
  listWorkspacePaneContents,
  splitWorkspaceContentSequence,
  workspacePaneOtherContents,
  minimumWorkspacePaneExtent,
  type SplitDirection,
  type WorkspacePane,
} from "../../lib/ptyWorkspaceLayout";
import {
  encodeWorkspaceContentDrag,
  parseWorkspaceContentDrag,
  WORKSPACE_CONTENT_DRAG_TYPE,
} from "../../lib/workspaceContentDrag";
import {
  type WorkspaceFileDocument,
  type WorkspacePaneContentRef,
} from "../../lib/tauri";
import { formatAppError } from "../../lib/appErrors";
import {
  contentRefFromKey,
  fileContentKey,
  workspaceContentKey,
} from "../../lib/workspaceContentKey";
import {
  WorkspaceContentView,
  presentWorkspaceContent,
  tryGetWorkspaceContentAdapter,
  workspaceContentProjectContext,
  type WorkspaceContentPresentationContext,
} from "../../components/WorkspaceContentView";
import { WorkspaceContentTab } from "../../components/WorkspaceContentTab";
import { WorkspaceContentContextMenu } from "../../components/WorkspaceContentContextMenu";
import { partitionVisibleTabs } from "../../lib/workspaceTabLayout";
import { type PtyWorkspaceSlot } from "../../components/WorkspacePtySessionRegistry";
import { WorkspaceTreeViewProps } from "./WorkspaceTreeView";
import { beginWorkspaceSessionDrag } from "./viewHelpers";
import { PaneContentStack } from "./PaneContentStack";

export type ResolvedPaneContent =
  | {
      content: Extract<WorkspacePaneContentRef, { kind: "pty" }>;
      slot: PtyWorkspaceSlot;
    }
  | {
      content: Extract<WorkspacePaneContentRef, { kind: "file" }>;
      file: WorkspaceFileDocument;
    }
  | {
      content: Extract<WorkspacePaneContentRef, { kind: "unknown" }>;
    };

/**
 * @param coordinator 仅测试注入：宿主 harness 用它观察与断言内容归属状态。
 * 生产代码（`App.tsx`）不传该属性，行为与注入前完全一致。
 */

export function WorkspacePaneView({
  pane,
  slots,
  fileDocuments,
  fileBuffers,
  handoffFileIds,
  detachedFileIds,
  closingContentKeys,
  focusedPaneId,
  portalTargets,
  canCloseEmptyPane,
  selectedDirectoryId,
  directories,
  ptySessionsById,
  workspacePanes,
  onFocusPane,
  onActivateSession,
  onActivateFile,
  onActivateUnsupportedContent,
  onCloseContents,
  onDetachFile,
  onMoveFile,
  onEditFile,
  onLoadFile,
  onSaveFile,
  onSplitPane,
  onSplitAndMoveSession,
  onSplitAndMoveFile,
  onMoveSession,
  hasDetachedSessions,
  isManagedDetachedDrag,
  isManagedDetachedFileDrag,
  onDetachSession,
  onCloseEmptyPane,
}: WorkspaceTreeViewProps & {
  pane: Extract<WorkspaceNode, { kind: "pane" }>;
}) {
  const { t } = useTranslation();
  const paneName = t("pty.paneNumber", { number: pane.paneNumber });
  const presentationContext: WorkspaceContentPresentationContext = {
    directories,
    ptySlots: slots,
    ptySessionsById,
    fileDocuments,
    fileBuffers,
    selectedDirectoryId,
  };
  const paneSlots = listWorkspacePaneContents(pane, "pty")
    .map((content) =>
      content.kind === "pty"
        ? slots.find((slot) => slot.instanceId === content.slotId)
        : undefined,
    )
    .filter((slot): slot is PtyWorkspaceSlot => Boolean(slot));
  const activeFileId =
    pane.activeContent?.kind === "file" ? pane.activeContent.documentId : null;
  const activeFile = activeFileId
    ? fileDocuments.find((document) => document.id === activeFileId)
    : undefined;
  const paneContentEntries: ResolvedPaneContent[] = pane.contents.flatMap(
    (content): ResolvedPaneContent[] => {
      if (content.kind === "pty") {
        const slot = slots.find(
          (candidate) => candidate.instanceId === content.slotId,
        );
        return slot ? [{ content, slot }] : [];
      }
      if (content.kind === "unknown") return [{ content }];
      const file = fileDocuments.find(
        (candidate) => candidate.id === content.documentId,
      );
      return file && !detachedFileIds.has(file.id) ? [{ content, file }] : [];
    },
  );
  const contentSequence = splitWorkspaceContentSequence(
    paneContentEntries,
    pane.activeContent,
  );
  const activeContentEntry = contentSequence.active;
  const activeFileBuffer = activeFileId ? fileBuffers[activeFileId] : undefined;
  const activeSlot =
    activeContentEntry && "slot" in activeContentEntry
      ? activeContentEntry.slot
      : undefined;
  const tabStripRef = useRef<HTMLDivElement>(null);
  const [tabStripWidth, setTabStripWidth] = useState(0);
  const [tabWidths, setTabWidths] = useState<Record<string, number>>({});
  const observerRef = useRef<ResizeObserver | null>(null);
  const observedTabsRef = useRef(new Set<Element>());
  const measureTabsRef = useRef<() => void>(() => undefined);

  useLayoutEffect(() => {
    const tabStrip = tabStripRef.current;
    if (!tabStrip || typeof ResizeObserver === "undefined") return;

    measureTabsRef.current = () => {
      const nextStripWidth = tabStrip.clientWidth;
      setTabStripWidth((current) =>
        Math.abs(current - nextStripWidth) < 1 ? current : nextStripWidth,
      );
      const nextWidths: Record<string, number> = {};
      tabStrip
        .querySelectorAll<HTMLElement>("[data-workspace-content-key]")
        .forEach((element) => {
          const key = element.dataset.workspaceContentKey;
          const width = element.getBoundingClientRect().width;
          if (key && width > 0) nextWidths[key] = width;
        });
      setTabWidths((current) => {
        const keys = Object.keys(nextWidths);
        if (
          keys.length === Object.keys(current).length &&
          keys.every(
            (key) => Math.abs((current[key] ?? 0) - nextWidths[key]) < 1,
          )
        ) {
          return current;
        }
        return nextWidths;
      });
    };

    const observer = new ResizeObserver(() => measureTabsRef.current());
    observerRef.current = observer;
    observer.observe(tabStrip);
    return () => {
      observer.disconnect();
      observedTabsRef.current.clear();
      observerRef.current = null;
    };
  }, []);

  // Re-register tab elements after every render: tabs remount when they move
  // between the visible strip and the overflow stack, and titles change.
  useLayoutEffect(() => {
    const tabStrip = tabStripRef.current;
    const observer = observerRef.current;
    if (!tabStrip || !observer) return;
    const present = new Set<Element>(
      tabStrip.querySelectorAll("[data-workspace-content-key]"),
    );
    for (const element of observedTabsRef.current) {
      if (!present.has(element)) {
        observer.unobserve(element);
        observedTabsRef.current.delete(element);
      }
    }
    for (const element of present) {
      if (!observedTabsRef.current.has(element)) {
        observer.observe(element);
        observedTabsRef.current.add(element);
      }
    }
    measureTabsRef.current();
  });
  const activeTabIndex = Math.max(
    0,
    paneContentEntries.findIndex(
      (entry) =>
        pane.activeContent &&
        workspaceContentKey(entry.content) ===
          workspaceContentKey(pane.activeContent),
    ),
  );
  const tabPartition = partitionVisibleTabs(
    paneContentEntries.map(
      (entry) =>
        tabWidths[workspaceContentKey(entry.content)] ??
        Number.POSITIVE_INFINITY,
    ),
    tabStripWidth,
    activeTabIndex,
    40,
  );
  const visibleTabIndexes = new Set(tabPartition.visible);
  const visibleTabEntries = paneContentEntries.filter((_, index) =>
    visibleTabIndexes.has(index),
  );
  const stackedTabEntries = paneContentEntries.filter(
    (_, index) => !visibleTabIndexes.has(index),
  );
  const related = paneSlots.some(
    (slot) => slot.directoryId === selectedDirectoryId,
  );
  const focused = pane.id === focusedPaneId;
  const contentRef = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<{
    target:
      | { kind: "pty"; instanceId: string }
      | { kind: "file"; documentId: string };
    x: number;
    y: number;
  } | null>(null);
  const [dropActive, setDropActive] = useState(false);

  useEffect(() => {
    if (activeFileId && !activeFileBuffer) {
      void onLoadFile(activeFileId).catch((reason) =>
        toast.error(formatAppError(reason, t)),
      );
    }
  }, [activeFileBuffer, activeFileId, onLoadFile]);

  useEffect(() => {
    const clearDropTarget = () => setDropActive(false);
    window.addEventListener("drop", clearDropTarget, true);
    window.addEventListener("dragend", clearDropTarget);
    return () => {
      window.removeEventListener("drop", clearDropTarget, true);
      window.removeEventListener("dragend", clearDropTarget);
    };
  }, []);

  const requestSplit = (direction: SplitDirection, instanceId?: string) => {
    if (instanceId) onActivateSession(pane.id, instanceId);
    const bounds = contentRef.current?.parentElement?.getBoundingClientRect();
    if (
      !bounds ||
      !canSplitWorkspacePane(bounds.width, bounds.height, direction)
    ) {
      toast.info(
        t("pty.splitTooSmall", {
          axis: direction === "horizontal" ? t("pty.width") : t("pty.height"),
          size: minimumWorkspacePaneExtent(direction),
        }),
      );
      return;
    }
    onSplitPane(pane.id, direction);
  };

  const requestSplitAndMove = (
    direction: SplitDirection,
    instanceId: string,
  ) => {
    const bounds = contentRef.current?.parentElement?.getBoundingClientRect();
    if (
      !bounds ||
      !canSplitWorkspacePane(bounds.width, bounds.height, direction)
    ) {
      toast.info(
        t("pty.splitTooSmall", {
          axis: direction === "horizontal" ? t("pty.width") : t("pty.height"),
          size: minimumWorkspacePaneExtent(direction),
        }),
      );
      return;
    }
    onSplitAndMoveSession(pane.id, instanceId, direction);
  };

  const renderContentTab = (
    entry: ResolvedPaneContent,
    measureOnly = false,
  ) => {
    const { content } = entry;
    const key = workspaceContentKey(content);
    const isClosing = closingContentKeys.has(key);
    const presentation = presentWorkspaceContent(content, presentationContext);
    const adapter =
      content.kind === "unknown"
        ? undefined
        : tryGetWorkspaceContentAdapter(content.kind);
    const title = presentation.title;
    const isActive =
      pane.activeContent !== null &&
      pane.activeContent !== undefined &&
      workspaceContentKey(pane.activeContent) === key;
    const projectId = workspaceContentProjectContext(
      content,
      presentationContext,
    );

    return (
      <WorkspaceContentTab
        key={key}
        contentKey={key}
        measureOnly={measureOnly}
        title={title}
        active={isActive}
        related={projectId !== null && projectId === selectedDirectoryId}
        closeLabel={t(presentation.closeLabelKey)}
        closeAccessibleName={
          adapter
            ? t(adapter.labels.closeCurrent, { name: title })
            : t("workspaceContent.closeUnsupported")
        }
        draggable={content.kind !== "unknown" && !isClosing && !!adapter}
        onDragStart={(event) => {
          if (isClosing) return;
          if (content.kind === "pty") {
            beginWorkspaceSessionDrag(event, pane.id, content.slotId);
            return;
          }
          if (content.kind === "unknown" || isClosing || !adapter) return;
          const payload = encodeWorkspaceContentDrag({
            key: fileContentKey(content.documentId),
            sourcePaneId: pane.id,
            sourceWindowLabel: "main",
          });
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData(WORKSPACE_CONTENT_DRAG_TYPE, payload);
          event.dataTransfer.setData("text/plain", payload);
        }}
        onActivate={() => {
          if (content.kind === "pty")
            onActivateSession(pane.id, content.slotId);
          else if (content.kind === "file")
            onActivateFile(pane.id, content.documentId);
          else onActivateUnsupportedContent(pane.id, content);
        }}
        onRequestClose={() => void onCloseContents([content], "tab")}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (content.kind === "unknown" || isClosing) return;
          onFocusPane(pane.id);
          setContextMenu({
            target:
              content.kind === "pty"
                ? { kind: "pty", instanceId: content.slotId }
                : { kind: "file", documentId: content.documentId },
            x: event.clientX,
            y: event.clientY,
          });
        }}
      >
        {presentation.icon}
        {isClosing ? (
          <span
            className="pty-pane-tab-status terminating"
            title={t("pty.terminating")}
            aria-label={t("pty.terminating")}
          />
        ) : presentation.status && presentation.status !== "dirty" ? (
          <span
            className={clsx("pty-pane-tab-status", {
              running: presentation.status === "running",
              failed: presentation.status === "failed",
            })}
            aria-hidden="true"
          />
        ) : null}
        <span
          className="pty-pane-tab-title"
          title={presentation.tooltip ?? title}
        >
          {content.kind === "file" ? title.split(/[\\/]/).pop() : title}
          {presentation.status === "dirty" ? " •" : ""}
        </span>
      </WorkspaceContentTab>
    );
  };

  return (
    <section
      className={clsx("pty-workspace-pane", {
        focused,
        related,
        "drop-active": dropActive,
      })}
      aria-label={paneName}
      onMouseDown={() => onFocusPane(pane.id)}
      onDragOverCapture={(event) => {
        const types = Array.from(event.dataTransfer.types);
        if (
          !types.includes(WORKSPACE_CONTENT_DRAG_TYPE) &&
          !(hasDetachedSessions && types.includes("text/plain"))
        ) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        setDropActive(true);
      }}
      onDragLeaveCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setDropActive(false);
        }
      }}
      onDropCapture={(event) => {
        const types = Array.from(event.dataTransfer.types);
        if (
          !types.includes(WORKSPACE_CONTENT_DRAG_TYPE) &&
          !(hasDetachedSessions && types.includes("text/plain"))
        ) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        setDropActive(false);
        const contentPayload = parseWorkspaceContentDrag(
          event.dataTransfer.getData(WORKSPACE_CONTENT_DRAG_TYPE),
        );
        const draggedRef = contentPayload
          ? contentRefFromKey(contentPayload.key)
          : null;
        if (!contentPayload || !draggedRef) return;
        if (
          contentPayload.sourceWindowLabel === "main" &&
          "sourcePaneId" in contentPayload
        ) {
          if (draggedRef.kind === "file") {
            onMoveFile(
              contentPayload.sourcePaneId,
              pane.id,
              draggedRef.documentId,
            );
          } else {
            onMoveSession(
              contentPayload.sourcePaneId,
              pane.id,
              draggedRef.slotId,
            );
          }
          return;
        }
        if (
          draggedRef.kind === "pty" &&
          contentPayload.sourceWindowLabel !== "main" &&
          isManagedDetachedDrag(
            draggedRef.slotId,
            contentPayload.sourceWindowLabel,
          )
        ) {
          void emitWorkspaceContentWindowEvent(
            contentPayload.sourceWindowLabel,
            "pty-return-drop-requested",
            { instanceId: draggedRef.slotId, targetPaneId: pane.id },
          ).catch((reason) =>
            toast.error(
              t("pty.returnFailed", { error: formatAppError(reason, t) }),
            ),
          );
          return;
        }
        if (
          draggedRef.kind === "file" &&
          contentPayload.sourceWindowLabel !== "main" &&
          isManagedDetachedFileDrag(
            draggedRef.documentId,
            contentPayload.sourceWindowLabel,
          )
        ) {
          void emitWorkspaceContentWindowEvent(
            contentPayload.sourceWindowLabel,
            "workspace-file-window-return-drop-requested",
            { documentId: draggedRef.documentId, targetPaneId: pane.id },
          ).catch((reason) => toast.error(formatAppError(reason, t)));
        }
      }}
    >
      {dropActive && (
        <div className="pty-pane-drop-label" aria-hidden="true">
          {t("pty.dropIntoPane", { pane: paneName })}
        </div>
      )}
      <header className="pty-pane-header">
        <div className="pty-pane-identity">
          <span className="pty-pane-name">{paneName}</span>
          {pane.contents.length === 0 && (
            <span className="pty-pane-empty-title">{t("pty.emptyPane")}</span>
          )}
        </div>
        <div className="pty-pane-tabs" ref={tabStripRef}>
          <div
            className="pty-pane-active-tablist"
            role="tablist"
            aria-label={t("pty.paneSessions")}
          >
            {visibleTabEntries.map((entry) => renderContentTab(entry))}
          </div>
          {stackedTabEntries.length > 0 && (
            <PaneContentStack
              side="overflow"
              sourcePaneId={pane.id}
              entries={stackedTabEntries}
              directories={directories}
              ptySlots={slots}
              ptySessionsById={ptySessionsById}
              fileDocuments={fileDocuments}
              fileBuffers={fileBuffers}
              selectedDirectoryId={selectedDirectoryId}
              closingContentKeys={closingContentKeys}
              onActivate={(entry) => {
                if (entry.content.kind === "pty")
                  onActivateSession(pane.id, entry.content.slotId);
                else if (entry.content.kind === "file")
                  onActivateFile(pane.id, entry.content.documentId);
                else onActivateUnsupportedContent(pane.id, entry.content);
              }}
              onCloseContent={(entry) =>
                void onCloseContents([entry.content], "stack")
              }
              onContextMenu={(entry, x, y) => {
                if (entry.content.kind === "unknown") return;
                onFocusPane(pane.id);
                setContextMenu({
                  target:
                    entry.content.kind === "pty"
                      ? { kind: "pty", instanceId: entry.content.slotId }
                      : { kind: "file", documentId: entry.content.documentId },
                  x,
                  y,
                });
              }}
            />
          )}
          <div className="pty-pane-tab-measurements" aria-hidden="true">
            {stackedTabEntries.map((entry) => renderContentTab(entry, true))}
          </div>
        </div>
        <div className="pty-pane-actions">
          {canCloseEmptyPane &&
            paneSlots.length === 0 &&
            pane.contents.length === 0 && (
              <button
                type="button"
                className="icon-button"
                title={t("pty.closeEmptyPane")}
                aria-label={t("pty.closeEmptyPane")}
                onClick={(event) => {
                  event.stopPropagation();
                  onCloseEmptyPane(pane.id);
                }}
              >
                <X size={14} />
              </button>
            )}
          <button
            type="button"
            className="icon-button"
            title={t("pty.splitRight")}
            aria-label={t("pty.splitRight")}
            onClick={(event) => {
              event.stopPropagation();
              requestSplit("horizontal");
            }}
          >
            <Columns2 size={15} />
          </button>
          <button
            type="button"
            className="icon-button"
            title={t("pty.splitDown")}
            aria-label={t("pty.splitDown")}
            onClick={(event) => {
              event.stopPropagation();
              requestSplit("vertical");
            }}
          >
            <Rows2 size={15} />
          </button>
        </div>
      </header>
      <div className="pty-pane-content" ref={contentRef}>
        <WorkspaceContentView
          content={pane.activeContent}
          fileDocument={activeFile}
          fileBuffer={activeFileBuffer}
          readOnly={Boolean(activeFileId && handoffFileIds.has(activeFileId))}
          ptyPortalTarget={
            activeSlot ? portalTargets[activeSlot.instanceId] : undefined
          }
          onEditFile={onEditFile}
          onSaveFile={onSaveFile}
          onCloseUnsupported={() => {
            if (pane.activeContent) {
              void onCloseContents([pane.activeContent], "tab");
            }
          }}
        />
        {!activeContentEntry && (
          <div className="pty-workspace-empty">{t("pty.empty")}</div>
        )}
      </div>
      {contextMenu &&
        (() => {
          const target = contextMenu.target;
          const isPty = target.kind === "pty";
          const targetId = isPty ? target.instanceId : target.documentId;
          const targetSlot = isPty
            ? slots.find((slot) => slot.instanceId === targetId)
            : undefined;
          const targetFile = isPty
            ? undefined
            : fileDocuments.find((file) => file.id === targetId);
          const targetContent: WorkspacePaneContentRef = isPty
            ? { kind: "pty", slotId: targetId }
            : { kind: "file", documentId: targetId };
          if (!targetSlot && !targetFile) return null;
          const paneContentRefs = paneContentEntries.map(
            (entry) => entry.content,
          );
          const otherContents = workspacePaneOtherContents(
            paneContentRefs,
            targetContent,
          );
          const itemTitle = presentWorkspaceContent(
            targetContent,
            presentationContext,
          ).title;
          const adapter = tryGetWorkspaceContentAdapter(target.kind);
          if (!adapter) return null;
          const labels = {
            menu: t(adapter.labels.menu),
            closeCurrent: (name: string) =>
              t(adapter.labels.closeCurrent, { name }),
            closeOthers: (count: number) =>
              t(adapter.labels.closeOthers, { count }),
            closeAll: (count: number) => t(adapter.labels.closeAll, { count }),
            splitAndMoveRight: t(adapter.labels.splitAndMoveRight),
            splitAndMoveDown: t(adapter.labels.splitAndMoveDown),
          };
          const requestCloseContents = (
            contents: WorkspacePaneContentRef[],
            afterApproval?: () => void,
          ) => {
            setContextMenu(null);
            void onCloseContents(contents, "menu", afterApproval);
          };
          return (
            <WorkspaceContentContextMenu
              title={itemTitle}
              x={contextMenu.x}
              y={contextMenu.y}
              labels={labels}
              allowDetach={
                targetFile !== undefined ||
                (targetSlot?.sessionId
                  ? ptySessionsById[targetSlot.sessionId]?.state === "running"
                  : false)
              }
              otherContentCount={otherContents.length}
              paneContentCount={paneContentRefs.length}
              otherPanes={workspacePanes
                .filter((candidate) => candidate.id !== pane.id)
                .map((candidate) => ({
                  id: candidate.id,
                  title: workspacePaneTitle(
                    candidate,
                    presentationContext,
                    t("pty.paneNumber", { number: candidate.paneNumber }),
                    t("pty.emptyPane"),
                  ),
                }))}
              onClose={() => setContextMenu(null)}
              onSplit={(direction) => {
                setContextMenu(null);
                if (targetSlot)
                  onActivateSession(pane.id, targetSlot.instanceId);
                requestSplit(direction);
              }}
              onSplitAndMove={(direction) => {
                setContextMenu(null);
                if (targetSlot)
                  requestSplitAndMove(direction, targetSlot.instanceId);
                else if (targetFile) {
                  const bounds =
                    contentRef.current?.parentElement?.getBoundingClientRect();
                  if (
                    !bounds ||
                    !canSplitWorkspacePane(
                      bounds.width,
                      bounds.height,
                      direction,
                    )
                  ) {
                    toast.info(
                      t("pty.splitTooSmall", {
                        axis:
                          direction === "horizontal"
                            ? t("pty.width")
                            : t("pty.height"),
                        size: minimumWorkspacePaneExtent(direction),
                      }),
                    );
                    return;
                  }
                  onSplitAndMoveFile(pane.id, targetFile.id, direction);
                }
              }}
              onMoveToPane={(destinationPaneId) => {
                setContextMenu(null);
                if (targetSlot)
                  onMoveSession(
                    pane.id,
                    destinationPaneId,
                    targetSlot.instanceId,
                  );
                else if (targetFile)
                  onMoveFile(pane.id, destinationPaneId, targetFile.id);
              }}
              onDetach={() => {
                setContextMenu(null);
                if (targetSlot) onDetachSession(targetSlot.instanceId);
                else if (targetFile) onDetachFile(targetFile.id);
              }}
              onCloseCurrent={() => requestCloseContents([targetContent])}
              onCloseOthers={() =>
                requestCloseContents(otherContents, () => {
                  if (targetSlot)
                    onActivateSession(pane.id, targetSlot.instanceId);
                  if (targetFile) onActivateFile(pane.id, targetFile.id);
                })
              }
              onCloseAll={() => requestCloseContents(paneContentRefs)}
            />
          );
        })()}
    </section>
  );
}

export function workspacePaneTitle(
  pane: WorkspacePane,
  presentationContext: WorkspaceContentPresentationContext,
  paneName: string,
  emptyPaneLabel: string,
): string {
  const activeContent = pane.activeContent;
  const targetTitle = activeContent
    ? presentWorkspaceContent(activeContent, presentationContext).title
    : emptyPaneLabel;
  return `${paneName} · ${targetTitle}`;
}

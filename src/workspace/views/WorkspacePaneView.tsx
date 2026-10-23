import clsx from "clsx";
import { Columns2, Rows2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { sendContentHandoff } from "../../lib/workspaceContentWindowProtocol";
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
  fileContentRef,
  type ManagedContentRef,
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
import type { WorkspaceTreeViewProps } from "./WorkspaceTreeView";
import { beginWorkspaceContentDrag } from "./viewHelpers";
import { PaneContentStack } from "./PaneContentStack";
import { MAIN_WINDOW_LABEL } from "../../lib/windowKinds";

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

export function WorkspacePaneView({
  pane,
  slots,
  fileDocuments,
  fileBuffers,
  isHandoffContent,
  isDetachedContent,
  closingContentKeys,
  focusedPaneId,
  portalTargets,
  canCloseEmptyPane,
  selectedDirectoryId,
  directories,
  ptySessionsById,
  workspacePanes,
  onFocusPane,
  onActivateContent,
  onCloseContents,
  onDetachFile,
  onEditFile,
  onSaveFile,
  onSplitPane,
  onSplitAndMoveContent,
  onMoveContent,
  hasDetachedSessions,
  isManagedDetachedDrag,
  isManagedDetachedFileDrag,
  onDetachSession,
  onCloseEmptyPane,
}: WorkspaceTreeViewProps & {
  pane: Extract<WorkspaceNode, { kind: "pane" }>;
}) {
  const { t } = useTranslation();
  // R-FE-1：异步回调读取最新翻译函数，不让 effect 依赖 t。
  const tRef = useRef(t);
  tRef.current = t;
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
      return file && !isDetachedContent(fileContentRef(file.id)) ? [{ content, file }] : [];
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
    target: ManagedContentRef;
    x: number;
    y: number;
  } | null>(null);
  const [dropActive, setDropActive] = useState(false);

  useEffect(() => {
    const clearDropTarget = () => setDropActive(false);
    window.addEventListener("drop", clearDropTarget, true);
    window.addEventListener("dragend", clearDropTarget);
    return () => {
      window.removeEventListener("drop", clearDropTarget, true);
      window.removeEventListener("dragend", clearDropTarget);
    };
  }, []);

  const requestSplit = (
    direction: SplitDirection,
    content?: WorkspacePaneContentRef,
  ) => {
    if (content) onActivateContent(pane.id, content);
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
    content: WorkspacePaneContentRef,
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
    onSplitAndMoveContent(pane.id, content, direction);
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
          if (content.kind === "unknown" || isClosing || !adapter) return;
          beginWorkspaceContentDrag(event, pane.id, workspaceContentKey(content));
        }}
        onActivate={() => onActivateContent(pane.id, content)}
        onRequestClose={() => void onCloseContents([content], "tab")}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (content.kind === "unknown" || isClosing) return;
          onFocusPane(pane.id);
          setContextMenu({
            target: content,
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
          contentPayload.sourceWindowLabel === MAIN_WINDOW_LABEL &&
          "sourcePaneId" in contentPayload
        ) {
          onMoveContent(contentPayload.sourcePaneId, pane.id, draggedRef);
          return;
        }
        if (
          draggedRef.kind === "pty" &&
          contentPayload.sourceWindowLabel !== MAIN_WINDOW_LABEL &&
          isManagedDetachedDrag(
            draggedRef.slotId,
            contentPayload.sourceWindowLabel,
          )
        ) {
          void sendContentHandoff(
            contentPayload.sourceWindowLabel,
            "pty",
            "return-drop-requested",
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
          contentPayload.sourceWindowLabel !== MAIN_WINDOW_LABEL &&
          isManagedDetachedFileDrag(
            draggedRef.documentId,
            contentPayload.sourceWindowLabel,
          )
        ) {
          void sendContentHandoff(
            contentPayload.sourceWindowLabel,
            "file",
            "return-drop-requested",
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
              onActivate={(entry) => onActivateContent(pane.id, entry.content)}
              onCloseContent={(entry) =>
                void onCloseContents([entry.content], "stack")
              }
              onContextMenu={(entry, x, y) => {
                if (entry.content.kind === "unknown") return;
                onFocusPane(pane.id);
                setContextMenu({
                  target: entry.content,
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
          readOnly={Boolean(activeFileId && isHandoffContent(fileContentRef(activeFileId)))}
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
          const targetContent = contextMenu.target;
          const isPty = targetContent.kind === "pty";
          const targetId = isPty
            ? targetContent.slotId
            : targetContent.documentId;
          const targetSlot = isPty
            ? slots.find((slot) => slot.instanceId === targetId)
            : undefined;
          const targetFile = isPty
            ? undefined
            : fileDocuments.find((file) => file.id === targetId);
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
          const adapter = tryGetWorkspaceContentAdapter(targetContent.kind);
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
                // 会话在拆分前先成为激活内容（文件不需要）。
                requestSplit(direction, targetSlot ? targetContent : undefined);
              }}
              onSplitAndMove={(direction) => {
                setContextMenu(null);
                requestSplitAndMove(direction, targetContent);
              }}
              onMoveToPane={(destinationPaneId) => {
                setContextMenu(null);
                onMoveContent(pane.id, destinationPaneId, targetContent);
              }}
              onDetach={() => {
                setContextMenu(null);
                if (targetSlot) onDetachSession(targetSlot.instanceId);
                else if (targetFile) onDetachFile(targetFile.id);
              }}
              onCloseCurrent={() => requestCloseContents([targetContent])}
              onCloseOthers={() =>
                requestCloseContents(otherContents, () =>
                  onActivateContent(pane.id, targetContent),
                )
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

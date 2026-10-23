import { Allotment, type AllotmentHandle } from "allotment";
import { useEffect, useRef } from "react";
import {
  type WorkspaceNode,
  MIN_WORKSPACE_PANE_HEIGHT,
  MIN_WORKSPACE_PANE_WIDTH,
  isUsableWorkspaceSplitSizes,
  type SplitDirection,
  type WorkspacePane,
  workspaceSplitSizes,
  WORKSPACE_SASH_SIZE,
} from "../../lib/ptyWorkspaceLayout";
import {
  type WorkspaceFileDocument,
  type PtySession,
  type WorkspacePaneContentRef,
} from "../../lib/tauri";
import { type SplitResizePhase } from "../host/workspaceContexts";
import type { WorkspaceFileBuffer } from "../../lib/workspaceFileBuffer";
import { type PtyWorkspaceSlot } from "../../components/WorkspacePtySessionRegistry";
import { WorkspacePaneView } from "./WorkspacePaneView";

export interface WorkspaceTreeViewProps {
  node: WorkspaceNode;
  slots: PtyWorkspaceSlot[];
  fileDocuments: WorkspaceFileDocument[];
  fileBuffers: Record<string, WorkspaceFileBuffer>;
  isHandoffContent: (content: WorkspacePaneContentRef) => boolean;
  isDetachedContent: (content: WorkspacePaneContentRef) => boolean;
  closingContentKeys: Set<string>;
  focusedPaneId: string;
  portalTargets: Record<string, HTMLDivElement>;
  canCloseEmptyPane: boolean;
  selectedDirectoryId: number | null;
  directories: { id: number; name: string }[];
  ptySessionsById: Record<string, PtySession>;
  workspacePanes: WorkspacePane[];
  onFocusPane: (paneId: string) => void;
  onActivateContent: (paneId: string, content: WorkspacePaneContentRef) => void;
  onCloseContents: (
    contents: WorkspacePaneContentRef[],
    origin: "tab" | "menu" | "stack" | "window",
    onApproved?: () => void,
  ) => Promise<void>;
  onDetachFile: (documentId: string) => void;
  onEditFile: (documentId: string, content: string) => void;
  onSaveFile: (documentId: string) => Promise<void>;
  onSplitPane: (paneId: string, direction: SplitDirection) => void;
  onSplitAndMoveContent: (
    paneId: string,
    content: WorkspacePaneContentRef,
    direction: SplitDirection,
  ) => void;
  onMoveContent: (
    sourcePaneId: string,
    destinationPaneId: string,
    content: WorkspacePaneContentRef,
  ) => void;
  hasDetachedSessions: boolean;
  isManagedDetachedDrag: (instanceId: string, windowLabel: string) => boolean;
  isManagedDetachedFileDrag: (
    documentId: string,
    windowLabel: string,
  ) => boolean;
  onDetachSession: (instanceId: string) => void;
  onCloseEmptyPane: (paneId: string) => void;
  onSplitResize: (
    splitId: string,
    sizes: number[],
    phase: SplitResizePhase,
  ) => void;
}

export function WorkspaceTreeView(props: WorkspaceTreeViewProps) {
  const { node, onSplitResize } = props;
  const splitHostRef = useRef<HTMLDivElement | null>(null);
  const allotmentRef = useRef<AllotmentHandle | null>(null);
  const appliedSplitRatioRef = useRef<{
    splitId: string;
    direction: SplitDirection;
    ratio: number;
  } | null>(null);
  const applyingSplitRatioRef = useRef(false);
  const splitId = node.kind === "split" ? node.id : null;
  const splitDirection = node.kind === "split" ? node.direction : null;
  const splitRatio = node.kind === "split" ? node.ratio : null;

  useEffect(() => {
    if (splitId === null || splitDirection === null || splitRatio === null) {
      appliedSplitRatioRef.current = null;
      return;
    }

    const applied = appliedSplitRatioRef.current;
    if (
      applied?.splitId === splitId &&
      applied.direction === splitDirection &&
      Math.abs(applied.ratio - splitRatio) < 0.0001
    ) {
      return;
    }

    // The workspace can be mounted while its parent view is hidden or before
    // the native window has completed its restored geometry. Wait until the
    // split host has a real extent instead of permanently missing the one-shot
    // initial ratio application.
    const applyRatio = () => {
      const host = splitHostRef.current;
      const allotment = allotmentRef.current;
      if (!host || !allotment) return;

      const appliedNow = appliedSplitRatioRef.current;
      if (
        appliedNow?.splitId === splitId &&
        appliedNow.direction === splitDirection &&
        Math.abs(appliedNow.ratio - splitRatio) < 0.0001
      ) {
        return;
      }

      const extent =
        splitDirection === "horizontal" ? host.clientWidth : host.clientHeight;
      if (extent <= WORKSPACE_SASH_SIZE) return;

      const sizes = workspaceSplitSizes(splitRatio, extent);
      if (!isUsableWorkspaceSplitSizes(sizes)) return;

      applyingSplitRatioRef.current = true;
      try {
        allotment.resize(sizes);
        appliedSplitRatioRef.current = {
          splitId,
          direction: splitDirection,
          ratio: splitRatio,
        };
      } catch (error) {
        // Keep the workspace mounted; preferredSize remains the safe fallback.
        console.error("Failed to apply the workspace split ratio", error);
      } finally {
        applyingSplitRatioRef.current = false;
      }
    };

    let frame = 0;
    const scheduleApply = () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      // Allotment registers its pane views after the initial layout effect.
      // The frame also lets ResizeObserver report dimensions after visibility
      // and native window restoration have settled.
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        applyRatio();
      });
    };

    const host = splitHostRef.current;
    const observer =
      host && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(scheduleApply)
        : null;
    if (host) observer?.observe(host);
    scheduleApply();

    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [splitDirection, splitId, splitRatio]);

  if (node.kind === "pane") return <WorkspacePaneView {...props} pane={node} />;

  const firstSize = String(Math.round(node.ratio * 10000) / 100) + "%";
  const secondSize = String(Math.round((1 - node.ratio) * 10000) / 100) + "%";
  return (
    <div ref={splitHostRef} className="pty-workspace-split-host">
      <Allotment
        // A split can be promoted from a nested child to the workspace root
        // when its sibling pane closes. Remount Allotment when the tree node
        // identity changes so its cached orientation and pane sizes cannot
        // leak across the new topology.
        key={`${node.id}:${node.direction}`}
        ref={allotmentRef}
        id={node.id}
        className="pty-workspace-split"
        vertical={node.direction === "vertical"}
        proportionalLayout
        separator
        onChange={(sizes) => {
          if (!applyingSplitRatioRef.current) {
            onSplitResize(node.id, sizes, "change");
          }
        }}
        onDragEnd={(sizes) => {
          const total = sizes.reduce((sum, size) => sum + size, 0);
          if (isUsableWorkspaceSplitSizes(sizes) && total > 0) {
            appliedSplitRatioRef.current = {
              splitId: node.id,
              direction: node.direction,
              ratio: sizes[0] / total,
            };
          }
          onSplitResize(node.id, sizes, "dragEnd");
        }}
      >
        <Allotment.Pane
          minSize={
            node.direction === "horizontal"
              ? MIN_WORKSPACE_PANE_WIDTH
              : MIN_WORKSPACE_PANE_HEIGHT
          }
          preferredSize={firstSize}
        >
          <WorkspaceTreeView {...props} node={node.first} />
        </Allotment.Pane>
        <Allotment.Pane
          minSize={
            node.direction === "horizontal"
              ? MIN_WORKSPACE_PANE_WIDTH
              : MIN_WORKSPACE_PANE_HEIGHT
          }
          preferredSize={secondSize}
        >
          <WorkspaceTreeView {...props} node={node.second} />
        </Allotment.Pane>
      </Allotment>
    </div>
  );
}

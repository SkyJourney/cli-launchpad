import { createContext, useContext, useRef, useSyncExternalStore } from "react";
import type { PtyWorkspaceSlot } from "../../components/WorkspacePtySessionRegistry";
import {
  createWorkspacePane,
  type WorkspaceNode,
} from "../../lib/ptyWorkspaceLayout";
import type { WorkspaceFileDocument } from "../../lib/tauri";
import type { WorkspaceFileBuffer } from "../../lib/workspaceFileBuffer";

export type HostHydrationStatus =
  | "loading"
  | "ready"
  | "needsReset"
  | "loadFailed";

export interface HostSnapshot {
  tree: WorkspaceNode;
  treeRevision: number;
  focusedPaneId: string;
  slots: PtyWorkspaceSlot[];
  documents: WorkspaceFileDocument[];
  buffers: Record<string, WorkspaceFileBuffer>;
  hydrationStatus: HostHydrationStatus;
}

const SNAPSHOT_FIELDS = [
  "tree",
  "treeRevision",
  "focusedPaneId",
  "slots",
  "documents",
  "buffers",
  "hydrationStatus",
] as const satisfies readonly (keyof HostSnapshot)[];

function sameSnapshot(left: HostSnapshot, right: HostSnapshot): boolean {
  return SNAPSHOT_FIELDS.every((field) => Object.is(left[field], right[field]));
}

export function createInitialHostSnapshot(initialPaneId: string): HostSnapshot {
  return {
    tree: createWorkspacePane(initialPaneId),
    treeRevision: 0,
    focusedPaneId: initialPaneId,
    slots: [],
    documents: [],
    buffers: {},
    hydrationStatus: "loading",
  };
}

export class WorkspaceHostStore {
  private snapshot: HostSnapshot;
  private transientTree: WorkspaceNode | null = null;
  private liveCache: {
    base: HostSnapshot;
    tree: WorkspaceNode;
    live: HostSnapshot;
  } | null = null;
  private readonly listeners = new Set<() => void>();
  private commits = 0;
  private reason: string | null = null;

  constructor(initial: HostSnapshot) {
    this.snapshot = initial;
  }

  /** Published snapshot. Its identity changes only when a commit changes a field. */
  getSnapshot = (): HostSnapshot => this.snapshot;

  /** Published snapshot with the unpublished drag tree applied (if any). */
  getLive = (): HostSnapshot => {
    const tree = this.transientTree;
    if (tree === null) return this.snapshot;
    const cache = this.liveCache;
    if (cache && cache.base === this.snapshot && cache.tree === tree) {
      return cache.live;
    }
    const live = { ...this.snapshot, tree };
    this.liveCache = { base: this.snapshot, tree, live };
    return live;
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Replaces the tree without publishing or notifying (split-ratio dragging). */
  setTransientTree = (tree: WorkspaceNode): void => {
    this.transientTree = tree;
    this.liveCache = null;
  };

  /**
   * The only write path. `recipe` receives the published snapshot (never the
   * transient tree) and returns the next snapshot. Unchanged results do not
   * notify. A commit that changes `tree` publishes it and clears the transient
   * tree; a commit that keeps `tree` leaves an in-progress drag unpublished.
   */
  commit = (
    recipe: (published: HostSnapshot) => HostSnapshot,
    reason: string,
  ): HostSnapshot => {
    const published = this.snapshot;
    const next = recipe(published);
    if (next.tree !== published.tree) {
      this.transientTree = null;
      this.liveCache = null;
    }
    if (sameSnapshot(next, published)) return published;
    this.snapshot = next;
    this.commits += 1;
    this.reason = reason;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        console.error("Workspace host store listener failed", error);
      }
    }
    return next;
  };

  get commitCount(): number {
    return this.commits;
  }

  get lastReason(): string | null {
    return this.reason;
  }
}

export const WorkspaceHostStoreContext =
  createContext<WorkspaceHostStore | null>(null);

export function useWorkspaceHostStore(): WorkspaceHostStore {
  const store = useContext(WorkspaceHostStoreContext);
  if (!store) throw new Error("WorkspaceHostStoreContext is missing");
  return store;
}

export function useWorkspaceSelector<T>(
  selector: (snapshot: HostSnapshot) => T,
  isEqual: (left: T, right: T) => boolean = Object.is,
): T {
  const store = useWorkspaceHostStore();
  const cache = useRef<{
    snapshot: HostSnapshot;
    selector: (snapshot: HostSnapshot) => T;
    selected: T;
  } | null>(null);
  const getSelection = (): T => {
    const snapshot = store.getSnapshot();
    const previous = cache.current;
    if (
      previous &&
      previous.snapshot === snapshot &&
      previous.selector === selector
    ) {
      return previous.selected;
    }
    const selected = selector(snapshot);
    const stable =
      previous && isEqual(previous.selected, selected)
        ? previous.selected
        : selected;
    cache.current = { snapshot, selector, selected: stable };
    return stable;
  };
  return useSyncExternalStore(store.subscribe, getSelection, getSelection);
}

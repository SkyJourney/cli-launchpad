import type { TFunction } from "i18next";
import {
  formatAppError,
  isProjectIdentityChangedError,
} from "../../lib/appErrors";
import {
  applyCaseVariantMerge,
  findCaseVariantGroups,
  listPlacedFileIds,
  type CaseMergeGroup,
} from "../../lib/caseVariantMerge";
import {
  documentIdentityKey,
  UNKNOWN_PATH_SEMANTICS,
  type PathSemantics,
} from "../../lib/pathKey";
import {
  openProjectFile,
  saveProjectTextFile,
  type FileIdentityComparison,
  type ProjectTextFileSaveResult,
  type WorkspaceFileDocument,
} from "../../lib/tauri";
import {
  beginWorkspaceFileSave,
  completeWorkspaceFileSave,
  createWorkspaceFileBuffer,
  editWorkspaceFileBuffer,
  hasUnsavedWorkspaceFileEdits,
  failWorkspaceFileSave,
  markWorkspaceFileIdentityChanged,
  markWorkspaceFileSaveConflict,
  resolveWorkspaceFileSaveCommitDisposition,
  WorkspaceFileOperationFlights,
  type WorkspaceFileBuffer,
} from "../../lib/workspaceFileBuffer";
import { closeWorkspaceFileState } from "../../lib/workspaceFileClose";
import type {
  HostSnapshot,
  WorkspaceHostStore,
} from "../host/workspaceHostStore";

export interface FileDocumentsDomainServices {
  /** True while a backup restore is being confirmed or applied. */
  isRestoreInProgress: () => boolean;
  /** Monotonic counter that changes whenever the host starts a hydration. */
  getHydrationEpoch: () => number;
  /** True while the coordinator reports detaching or returning for the file. */
  isHandoffActive: (documentId: string) => boolean;
  /** Must return the latest translation function at call time (R-FE-1). */
  getTranslate: () => TFunction;
  /**
   * The probed path semantics of a project (PD-10); `unknown` while nothing is known. Without
   * it every project is `unknown`, which never folds.
   */
  getPathSemantics?: (directoryId: number) => PathSemantics;
  /**
   * Loads (once, single-flight) and returns the semantics of a project; asked before a
   * file is opened in a project whose semantics are still unknown.
   */
  loadPathSemantics?: (
    directoryId: number,
    directoryPath: string,
  ) => Promise<PathSemantics>;
  /** Whether two project files are the same file on disk; may reject. */
  compareFileIdentity?: (
    directoryId: number,
    directoryPath: string,
    a: string,
    b: string,
  ) => Promise<FileIdentityComparison>;
  /** Releases documents the domain removed on its own (merged case variants). */
  releaseDocuments?: (documentIds: readonly string[]) => void;
  notify: {
    error: (
      message: string,
      options?: { action?: { label: string; onClick: () => void } },
    ) => void;
    warning: (message: string) => void;
  };
}

export interface FileDocumentOpenArgs {
  directoryId: number;
  directoryPath: string;
  relativePath: string;
}

export interface FileDocumentsDomain {
  /**
   * Dedupes by the exact path over the whole operation (and, for a project that is not known to
   * be case sensitive, by file identity), ensures the document and its buffer exist, then runs
   * `place`.
   */
  open: (
    args: FileDocumentOpenArgs,
    place: (document: WorkspaceFileDocument) => void | Promise<void>,
  ) => Promise<void>;
  load: (documentId: string) => Promise<void>;
  edit: (documentId: string, content: string) => void;
  reload: (documentId: string) => Promise<void>;
  save: (documentId: string) => Promise<void>;
  /** One store commit: tree entries, documents and buffers; invalidates loads. */
  closeDocuments: (documentIds: string[]) => { closedDocumentIds: string[] };
  /** Shallow-merges the entries into the live buffers in one commit. */
  mergeBuffers: (
    entries: Record<string, WorkspaceFileBuffer>,
    reason: string,
  ) => void;
  invalidateLoads: (documentIds: Iterable<string>) => void;
  /**
   * Merges documents of an insensitive project whose paths differ only by case, once the
   * backend confirmed they are the same file (or could not tell). One store commit. Variants
   * with unsaved edits keep their whole group. Returns the number of documents merged away;
   * 0 when a hydration or restore started meanwhile.
   */
  mergeCaseVariants: (
    directoryId: number,
    directoryPath: string,
    epoch: number,
  ) => Promise<number>;
  /**
   * Last resort after the backend refused a layout twice: drops the later variant of every
   * group among `documentIds` without asking the backend, except variants with unsaved edits.
   * Returns the number of documents dropped.
   */
  degradeCaseVariants: (documentIds: readonly string[]) => number;
  waitForSave: (documentId: string) => Promise<void>;
  waitForAllSaves: () => Promise<void>;
}

export function createFileDocumentsDomain(
  store: WorkspaceHostStore,
  services: FileDocumentsDomainServices,
): FileDocumentsDomain {
  const generations = new Map<string, number>();
  const openings = new Map<string, Promise<void>>();
  const openingKeys = new Map<
    string,
    { key: string; promise: Promise<void> }
  >();
  const flights = new WorkspaceFileOperationFlights();

  const semanticsOf = (directoryId: number): PathSemantics =>
    services.getPathSemantics?.(directoryId) ?? UNKNOWN_PATH_SEMANTICS;
  /** Semantics used to find candidates: an unknown project is searched as insensitive. */
  const candidateSemantics = (semantics: PathSemantics): PathSemantics =>
    semantics.case === "unknown"
      ? {
          case: "insensitive",
          normalizationInsensitive: semantics.normalizationInsensitive,
        }
      : semantics;
  const foldedKey = (directoryId: number, relativePath: string) =>
    documentIdentityKey(
      directoryId,
      relativePath,
      candidateSemantics(semanticsOf(directoryId)),
    );
  const hasUnsavedEdits = (documentId: string) =>
    hasUnsavedWorkspaceFileEdits(store.getLive().buffers[documentId]);
  /** Ids of documents shown in a pane; the others belong to another window or are in a handoff. */
  const placedInTree = () => listPlacedFileIds(store.getLive().tree);
  const commitMerge = (
    merged: CaseMergeGroup[],
    next: ReturnType<typeof applyCaseVariantMerge>,
  ) => {
    const removed = new Set(merged.flatMap((group) => group.variantIds));
    store.commit(
      (published) => ({
        ...published,
        tree: next.tree,
        documents: next.documents,
        buffers: Object.fromEntries(
          Object.entries(published.buffers).filter(([id]) => !removed.has(id)),
        ),
      }),
      "file:mergeCaseVariants",
    );
    removed.forEach(invalidate);
    services.releaseDocuments?.([...removed]);
    return removed.size;
  };
  const generationOf = (documentId: string) => generations.get(documentId) ?? 0;
  const invalidate = (documentId: string) => {
    generations.set(documentId, generationOf(documentId) + 1);
  };
  const patchFile = (patch: Partial<HostSnapshot>, reason: string) =>
    store.commit((published) => ({ ...published, ...patch }), reason);

  const load = (documentId: string): Promise<void> =>
    flights.load(documentId, async () => {
      if (store.getLive().buffers[documentId]) return;
      const document = store
        .getLive()
        .documents.find((entry) => entry.id === documentId);
      if (!document) return;
      const generationAtStart = generationOf(documentId);
      const loaded = createWorkspaceFileBuffer(
        await openProjectFile(
          document.directoryId,
          document.directoryPath,
          document.relativePath,
        ),
      );
      const currentDocument = store
        .getLive()
        .documents.find((entry) => entry.id === documentId);
      if (
        !currentDocument ||
        currentDocument.directoryId !== document.directoryId ||
        currentDocument.relativePath !== document.relativePath ||
        generationAtStart !== generationOf(documentId) ||
        store.getLive().buffers[documentId]
      ) {
        return;
      }
      const next = { ...store.getLive().buffers, [documentId]: loaded };
      patchFile({ buffers: next }, "file:load:buffers");
    });

  const edit = (documentId: string, content: string): void => {
    if (
      services.isRestoreInProgress() ||
      services.isHandoffActive(documentId)
    ) {
      return;
    }
    const buffer = store.getLive().buffers[documentId];
    if (!buffer) return;
    const next = {
      ...store.getLive().buffers,
      [documentId]: editWorkspaceFileBuffer(buffer, content),
    };
    patchFile({ buffers: next }, "file:edit:buffers");
  };

  const reload = (documentId: string): Promise<void> =>
    flights.load(documentId, async () => {
      await flights.waitForSave(documentId);
      const document = store
        .getLive()
        .documents.find((entry) => entry.id === documentId);
      const startingBuffer = store.getLive().buffers[documentId];
      if (!document || !startingBuffer) return;
      const generationAtStart = generationOf(documentId);
      try {
        const loaded = createWorkspaceFileBuffer(
          await openProjectFile(
            document.directoryId,
            document.directoryPath,
            document.relativePath,
          ),
          startingBuffer.epoch + 1,
        );
        const currentDocument = store
          .getLive()
          .documents.find((entry) => entry.id === documentId);
        const currentBuffer = store.getLive().buffers[documentId];
        if (
          !currentDocument ||
          currentDocument.directoryId !== document.directoryId ||
          currentDocument.relativePath !== document.relativePath ||
          !currentBuffer ||
          currentBuffer.epoch !== startingBuffer.epoch ||
          currentBuffer.version !== startingBuffer.version ||
          generationAtStart !== generationOf(documentId)
        ) {
          return;
        }
        const next = { ...store.getLive().buffers, [documentId]: loaded };
        patchFile({ buffers: next }, "file:reload:buffers");
      } catch (reason) {
        if (isProjectIdentityChangedError(reason)) {
          const current = store.getLive().buffers[documentId];
          if (current) {
            const next = {
              ...store.getLive().buffers,
              [documentId]: markWorkspaceFileIdentityChanged(current),
            };
            patchFile({ buffers: next }, "file:reload:buffers");
          }
          services.notify.error(
            services.getTranslate()("workspaceFiles.projectIdentityChanged"),
          );
          return;
        }
        services.notify.error(formatAppError(reason, services.getTranslate()));
      }
    });

  const save = (documentId: string): Promise<void> =>
    flights.save(documentId, async () => {
      if (
        services.isRestoreInProgress() ||
        services.isHandoffActive(documentId)
      ) {
        return;
      }
      const document = store
        .getLive()
        .documents.find((entry) => entry.id === documentId);
      const buffer = store.getLive().buffers[documentId];
      if (
        !document ||
        !buffer ||
        buffer.kind !== "text" ||
        buffer.identityChanged === true ||
        buffer.content === buffer.savedContent ||
        buffer.saving
      ) {
        return;
      }
      const submitted = beginWorkspaceFileSave(buffer);
      patchFile(
        {
          buffers: { ...store.getLive().buffers, [documentId]: submitted },
        },
        "file:save:begin",
      );
      const saveCommitDisposition = () => {
        const currentDocument = store
          .getLive()
          .documents.find((entry) => entry.id === documentId);
        const currentBuffer = store.getLive().buffers[documentId];
        return resolveWorkspaceFileSaveCommitDisposition(
          currentBuffer,
          submitted,
          Boolean(
            currentDocument &&
            currentDocument.directoryId === document.directoryId &&
            currentDocument.relativePath === document.relativePath,
          ),
        );
      };
      try {
        const result: ProjectTextFileSaveResult = await saveProjectTextFile(
          document.directoryId,
          document.directoryPath,
          document.relativePath,
          submitted.content,
          submitted.revision,
        );
        const disposition = saveCommitDisposition();
        if (disposition === "discard-result") return;
        if (disposition === "restore-saving-state") {
          const current = store.getLive().buffers[documentId];
          if (!current) return;
          const next = {
            ...store.getLive().buffers,
            [documentId]: failWorkspaceFileSave(current, submitted),
          };
          patchFile({ buffers: next }, "file:save:buffers");
          return;
        }
        if (result.kind === "conflict") {
          const current = store.getLive().buffers[documentId];
          if (!current) return;
          const next = {
            ...store.getLive().buffers,
            [documentId]: markWorkspaceFileSaveConflict(current, submitted),
          };
          patchFile({ buffers: next }, "file:save:buffers");
          services.notify.error(
            services.getTranslate()("workspaceFiles.saveConflict"),
            {
              action: {
                label: services.getTranslate()("workspaceFiles.reload"),
                onClick: () => void reload(documentId),
              },
            },
          );
          return;
        }
        const current = store.getLive().buffers[documentId];
        if (!current) return;
        const next = {
          ...store.getLive().buffers,
          [documentId]: completeWorkspaceFileSave(current, submitted, result),
        };
        patchFile({ buffers: next }, "file:save:buffers");
        if (result.warning === "permissionsNotRestored") {
          services.notify.warning(
            services.getTranslate()("workspaceFiles.permissionsNotRestored"),
          );
        }
      } catch (reason) {
        if (saveCommitDisposition() === "discard-result") return;
        const current = store.getLive().buffers[documentId];
        if (!current) return;
        if (isProjectIdentityChangedError(reason)) {
          const next = {
            ...store.getLive().buffers,
            [documentId]: markWorkspaceFileIdentityChanged(current),
          };
          patchFile({ buffers: next }, "file:save:buffers");
          services.notify.error(
            services.getTranslate()("workspaceFiles.projectIdentityChanged"),
          );
          return;
        }
        const next = {
          ...store.getLive().buffers,
          [documentId]: failWorkspaceFileSave(current, submitted),
        };
        patchFile({ buffers: next }, "file:save:buffers");
        services.notify.error(formatAppError(reason, services.getTranslate()));
      }
    });

  return {
    open: (args, place) => {
      const { directoryId, directoryPath, relativePath } = args;
      if (services.isRestoreInProgress()) return Promise.resolve();
      const hydrationAtStart = services.getHydrationEpoch();
      // The exact path is the in-flight key: the same literal path shares one operation.
      const identity = documentIdentityKey(
        directoryId,
        relativePath,
        UNKNOWN_PATH_SEMANTICS,
      );
      const pending = openings.get(identity);
      if (pending) return pending;
      let semantics = semanticsOf(directoryId);
      // Case variants being opened right now: wait for them (ignoring their failure) so two
      // variants never both create a document.
      const earlier: Promise<void>[] = [];
      if (semantics.case !== "sensitive") {
        const key = foldedKey(directoryId, relativePath);
        for (const [otherIdentity, other] of openingKeys) {
          if (other.key === key && otherIdentity !== identity) {
            earlier.push(other.promise.catch(() => undefined));
          }
        }
      }
      const operation = (async () => {
        if (earlier.length > 0) await Promise.all(earlier);
        if (
          services.isRestoreInProgress() ||
          hydrationAtStart !== services.getHydrationEpoch()
        ) {
          return;
        }
        const exact = store
          .getLive()
          .documents.find(
            (entry) =>
              entry.directoryId === directoryId &&
              entry.relativePath === relativePath,
          );
        let document = exact;
        // A document whose path folds to the same key is a candidate; only the file identity
        // (or, for an insensitive project, its absence) decides.
        const findCandidate = (sem: PathSemantics) => {
          const key = documentIdentityKey(
            directoryId,
            relativePath,
            candidateSemantics(sem),
          );
          return store
            .getLive()
            .documents.find(
              (entry) =>
                entry.directoryId === directoryId &&
                documentIdentityKey(
                  entry.directoryId,
                  entry.relativePath,
                  candidateSemantics(sem),
                ) === key,
            );
        };
        if (!document && semantics.case !== "sensitive") {
          let candidate = findCandidate(semantics);
          // Only a candidate makes the answer matter: look the project up when it is still unknown.
          if (
            candidate &&
            semantics.case === "unknown" &&
            services.loadPathSemantics
          ) {
            semantics = await services
              .loadPathSemantics(directoryId, directoryPath)
              .catch(() => UNKNOWN_PATH_SEMANTICS);
            if (
              hydrationAtStart !== services.getHydrationEpoch() ||
              services.isRestoreInProgress()
            ) {
              return;
            }
            candidate =
              semantics.case === "sensitive"
                ? undefined
                : findCandidate(semantics);
          }
          if (candidate) {
            const found = candidate;
            let comparison: FileIdentityComparison = "unavailable";
            try {
              comparison =
                (await services.compareFileIdentity?.(
                  directoryId,
                  directoryPath,
                  found.relativePath,
                  relativePath,
                )) ?? "unavailable";
            } catch {
              comparison = "unavailable";
            }
            if (
              hydrationAtStart !== services.getHydrationEpoch() ||
              services.isRestoreInProgress()
            ) {
              return;
            }
            const current = store
              .getLive()
              .documents.find((entry) => entry.id === found.id);
            const sameFile =
              comparison === "same" ||
              (comparison === "unavailable" &&
                semantics.case === "insensitive");
            if (current && sameFile) document = current;
          }
        }
        if (!document) {
          const loaded = createWorkspaceFileBuffer(
            await openProjectFile(directoryId, directoryPath, relativePath),
          );
          if (hydrationAtStart !== services.getHydrationEpoch()) {
            return;
          }
          document = {
            id: crypto.randomUUID(),
            directoryId,
            directoryPath,
            relativePath,
          };
          const nextDocuments = [...store.getLive().documents, document];
          const nextBuffers = {
            ...store.getLive().buffers,
            [document.id]: loaded,
          };
          patchFile(
            { documents: nextDocuments, buffers: nextBuffers },
            "file:open:add-document",
          );
        } else if (!store.getLive().buffers[document.id]) {
          const opened = document;
          const generationAtStart = generationOf(opened.id);
          // The document's own literal path is the one to read, not the requested spelling.
          const loaded = createWorkspaceFileBuffer(
            await openProjectFile(
              opened.directoryId,
              directoryPath,
              opened.relativePath,
            ),
          );
          const currentDocument = store
            .getLive()
            .documents.find((entry) => entry.id === opened.id);
          if (
            hydrationAtStart !== services.getHydrationEpoch() ||
            generationAtStart !== generationOf(opened.id) ||
            !currentDocument ||
            currentDocument.directoryId !== opened.directoryId ||
            currentDocument.relativePath !== opened.relativePath ||
            store.getLive().buffers[opened.id]
          ) {
            return;
          }
          const nextBuffers = {
            ...store.getLive().buffers,
            [opened.id]: loaded,
          };
          patchFile({ buffers: nextBuffers }, "file:open:load-buffer");
        }

        await place(document);
      })();
      openings.set(identity, operation);
      openingKeys.set(identity, {
        key:
          semantics.case === "sensitive"
            ? identity
            : foldedKey(directoryId, relativePath),
        promise: operation,
      });
      const clearPending = () => {
        if (openings.get(identity) === operation) {
          openings.delete(identity);
          openingKeys.delete(identity);
        }
      };
      void operation.then(clearPending, clearPending);
      return operation;
    },
    load,
    edit,
    reload,
    save,
    closeDocuments: (documentIds) => {
      const live = store.getLive();
      const next = closeWorkspaceFileState(
        { tree: live.tree, documents: live.documents, buffers: live.buffers },
        documentIds,
      );
      // 没有命中任何文档时不提交，避免拖拽中的临时树被误发布。
      if (next.closedDocumentIds.length === 0) {
        return { closedDocumentIds: [] };
      }
      store.commit(
        (published) => ({
          ...published,
          tree: next.tree,
          documents: next.documents,
          buffers: next.buffers,
        }),
        "file:close",
      );
      next.closedDocumentIds.forEach(invalidate);
      return { closedDocumentIds: next.closedDocumentIds };
    },
    mergeBuffers: (entries, reason) => {
      store.commit(
        (published) => ({
          ...published,
          buffers: { ...published.buffers, ...entries },
        }),
        reason,
      );
    },
    invalidateLoads: (documentIds) => {
      for (const id of documentIds) invalidate(id);
    },
    mergeCaseVariants: async (directoryId, directoryPath, epoch) => {
      if (
        services.isRestoreInProgress() ||
        services.getHydrationEpoch() !== epoch ||
        semanticsOf(directoryId).case !== "insensitive"
      ) {
        return 0;
      }
      const inputOf = () => {
        const live = store.getLive();
        return {
          documents: live.documents,
          tree: live.tree,
          detachedContents: [],
        };
      };
      const groupsOf = () => {
        const placed = placedInTree();
        const live = store.getLive();
        return (
          findCaseVariantGroups(inputOf(), semanticsOf)
            .filter((group) => group.directoryId === directoryId)
            // A document outside the tree belongs to another window: leave its group alone.
            .filter((group) =>
              [group.canonicalId, ...group.variantIds].every((id) =>
                placed.has(id),
              ),
            )
            .map((group) => ({
              group,
              pathOf: (id: string) =>
                live.documents.find((entry) => entry.id === id)?.relativePath ??
                "",
            }))
        );
      };
      const checks = groupsOf();
      if (checks.length === 0) return 0;
      const confirmed = new Set<string>();
      await Promise.all(
        checks.flatMap(({ group, pathOf }) =>
          group.variantIds.map(async (variantId) => {
            let comparison: FileIdentityComparison = "unavailable";
            try {
              comparison =
                (await services.compareFileIdentity?.(
                  directoryId,
                  directoryPath,
                  pathOf(group.canonicalId),
                  pathOf(variantId),
                )) ?? "unavailable";
            } catch {
              comparison = "unavailable";
            }
            if (comparison !== "different") {
              confirmed.add(`${group.canonicalId}|${variantId}`);
            }
          }),
        ),
      );
      if (
        services.isRestoreInProgress() ||
        services.getHydrationEpoch() !== epoch
      ) {
        return 0;
      }
      // The layout may have changed while the backend answered: merge what is still a group.
      const groups: CaseMergeGroup[] = groupsOf()
        .map(({ group }) => ({
          ...group,
          variantIds: group.variantIds.filter((variantId) =>
            confirmed.has(`${group.canonicalId}|${variantId}`),
          ),
        }))
        .filter((group) => group.variantIds.length > 0);
      const skip = new Set<string>();
      for (const group of groups) {
        const members = [group.canonicalId, ...group.variantIds];
        if (
          group.variantIds.some(hasUnsavedEdits) ||
          members.some((id) => services.isHandoffActive(id))
        ) {
          group.variantIds.forEach((id) => skip.add(id));
        }
      }
      const next = applyCaseVariantMerge(inputOf(), groups, skip);
      return next.merged.length === 0 ? 0 : commitMerge(next.merged, next);
    },
    degradeCaseVariants: (documentIds) => {
      if (services.isRestoreInProgress()) return 0;
      const wanted = new Set(documentIds);
      const input = {
        documents: store.getLive().documents,
        tree: store.getLive().tree,
        detachedContents: [],
      };
      const placed = placedInTree();
      // The backend judged these insensitive; the front end may not know yet.
      const groups = findCaseVariantGroups(input, (directoryId) =>
        candidateSemantics(semanticsOf(directoryId)),
      ).filter(
        (group) =>
          [group.canonicalId, ...group.variantIds].every((id) =>
            placed.has(id),
          ) &&
          [group.canonicalId, ...group.variantIds].some((id) => wanted.has(id)),
      );
      const skip = new Set<string>();
      for (const group of groups) {
        const members = [group.canonicalId, ...group.variantIds];
        if (
          group.variantIds.some(hasUnsavedEdits) ||
          members.some((id) => services.isHandoffActive(id))
        ) {
          group.variantIds.forEach((id) => skip.add(id));
        }
      }
      const next = applyCaseVariantMerge(input, groups, skip);
      return next.merged.length === 0 ? 0 : commitMerge(next.merged, next);
    },
    waitForSave: (documentId) => flights.waitForSave(documentId),
    waitForAllSaves: () =>
      Promise.all(
        store
          .getLive()
          .documents.map((document) => flights.waitForSave(document.id)),
      ).then(() => undefined),
  };
}

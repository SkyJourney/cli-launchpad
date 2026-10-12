import type { TFunction } from "i18next";
import {
  formatAppError,
  isProjectIdentityChangedError,
} from "../../lib/appErrors";
import {
  openProjectFile,
  saveProjectTextFile,
  type ProjectTextFileSaveResult,
  type WorkspaceFileDocument,
} from "../../lib/tauri";
import {
  beginWorkspaceFileSave,
  completeWorkspaceFileSave,
  createWorkspaceFileBuffer,
  editWorkspaceFileBuffer,
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
   * Dedupes by `${directoryId}:${relativePath}` over the whole operation,
   * ensures the document and its buffer exist, then runs `place`.
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
  waitForSave: (documentId: string) => Promise<void>;
  waitForAllSaves: () => Promise<void>;
}

export function createFileDocumentsDomain(
  store: WorkspaceHostStore,
  services: FileDocumentsDomainServices,
): FileDocumentsDomain {
  const generations = new Map<string, number>();
  const openings = new Map<string, Promise<void>>();
  const flights = new WorkspaceFileOperationFlights();

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
      const identity = `${directoryId}:${relativePath}`;
      const pending = openings.get(identity);
      if (pending) return pending;
      const operation = (async () => {
        const hydrationAtStart = services.getHydrationEpoch();
        let document = store
          .getLive()
          .documents.find(
            (entry) =>
              entry.directoryId === directoryId &&
              entry.relativePath === relativePath,
          );
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
          const generationAtStart = generationOf(document.id);
          const loaded = createWorkspaceFileBuffer(
            await openProjectFile(directoryId, directoryPath, relativePath),
          );
          const currentDocument = store
            .getLive()
            .documents.find((entry) => entry.id === document?.id);
          if (
            hydrationAtStart !== services.getHydrationEpoch() ||
            generationAtStart !== generationOf(document.id) ||
            !currentDocument ||
            currentDocument.directoryId !== directoryId ||
            currentDocument.relativePath !== relativePath ||
            store.getLive().buffers[document.id]
          ) {
            return;
          }
          const nextBuffers = {
            ...store.getLive().buffers,
            [document.id]: loaded,
          };
          patchFile({ buffers: nextBuffers }, "file:open:load-buffer");
        }

        await place(document);
      })();
      openings.set(identity, operation);
      const clearPending = () => {
        if (openings.get(identity) === operation) {
          openings.delete(identity);
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
    waitForSave: (documentId) => flights.waitForSave(documentId),
    waitForAllSaves: () =>
      Promise.all(
        store
          .getLive()
          .documents.map((document) => flights.waitForSave(document.id)),
      ).then(() => undefined),
  };
}

import { getCurrentWindow } from "@tauri-apps/api/window";
import { ArrowLeft, FileText } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WorkspaceFileDocument } from "../lib/tauri";
import { openProjectFile, saveProjectTextFile } from "../lib/tauri";
import {
  beginWorkspaceFileSave,
  completeWorkspaceFileSave,
  createWorkspaceFileBuffer,
  editWorkspaceFileBuffer,
  failWorkspaceFileSave,
  markWorkspaceFileIdentityChanged,
  markWorkspaceFileSaveConflict,
  WorkspaceFileOperationFlights,
  type WorkspaceFileBuffer,
} from "../lib/workspaceFileBuffer";
import {
  getAppErrorMessage,
  isProjectIdentityChangedError,
} from "../lib/appErrors";
import {
  encodeWorkspaceContentDrag,
  WORKSPACE_CONTENT_DRAG_TYPE,
} from "../lib/workspaceContentDrag";
import { WorkspaceContentView } from "./WorkspaceContentView";
import { WorkspaceContentWindowShell } from "./WorkspaceContentWindowShell";
import { getWorkspaceContentAdapter } from "./WorkspaceContentView";
import {
  emitWorkspaceContentWindowEvent,
  listenWorkspaceContentWindowEvent,
} from "../lib/workspaceContentWindowProtocol";
import { createWorkspaceFileBufferPublisher } from "../lib/workspaceFileBufferPublisher";
import {
  attachWorkspaceContentHandoff,
  WORKSPACE_CONTENT_WINDOW_HANDOFF_TIMEOUT_MS,
} from "./workspaceContentHandoffRuntime";
import type { WorkspaceContentHandoffHookContext } from "./workspaceContentAdapterRegistry";
import { completeWorkspaceFileWindowSetup } from "../lib/workspaceFileWindowSetup";

export function StandaloneWorkspaceFileWindow({
  documentId,
  token,
  sourcePaneId,
}: {
  documentId: string;
  token: string;
  sourcePaneId: string;
}) {
  const { t } = useTranslation();
  const [fileDocument, setFileDocument] = useState<WorkspaceFileDocument>();
  const [fileBuffer, setFileBuffer] = useState<WorkspaceFileBuffer>();
  const [returning, setReturning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileDocumentRef = useRef<WorkspaceFileDocument | undefined>(undefined);
  const currentBufferRef = useRef<WorkspaceFileBuffer | undefined>(undefined);
  const bufferPublisherRef = useRef<ReturnType<
    typeof createWorkspaceFileBufferPublisher
  > | null>(null);
  const fileOperationFlightsRef = useRef(new WorkspaceFileOperationFlights());
  const returningRef = useRef(false);
  const returnTimeoutRef = useRef<number | null>(null);
  currentBufferRef.current = fileBuffer;
  fileDocumentRef.current = fileDocument;
  returningRef.current = returning;

  if (bufferPublisherRef.current === null) {
    bufferPublisherRef.current = createWorkspaceFileBufferPublisher((payload) =>
      emitWorkspaceContentWindowEvent(
        "main",
        "workspace-file-window-buffer-changed",
        payload,
      ),
    );
  }

  const publishBufferSnapshot = useCallback(
    (buffer: WorkspaceFileBuffer | undefined) => {
      const document = fileDocumentRef.current;
      if (!document || !buffer) return;
      bufferPublisherRef.current?.publishLatest({
        documentId,
        token,
        windowLabel: getCurrentWindow().label,
        fileDocument: document,
        fileBuffer: buffer,
      });
    },
    [documentId, token],
  );

  const updateFileBuffer = useCallback(
    (
      update: (
        current: WorkspaceFileBuffer | undefined,
      ) => WorkspaceFileBuffer | undefined,
    ) => {
      const next = update(currentBufferRef.current);
      currentBufferRef.current = next;
      setFileBuffer(next);
      publishBufferSnapshot(next);
      return next;
    },
    [publishBufferSnapshot],
  );

  const requestReturn = useCallback(
    async (targetPaneId?: string) => {
      if (!fileDocument || !currentBufferRef.current || returningRef.current)
        return;
      returningRef.current = true;
      setReturning(true);
      setError(null);
      try {
        await fileOperationFlightsRef.current.waitForSave(documentId);
        await bufferPublisherRef.current?.flush();
      } catch (reason) {
        returningRef.current = false;
        setReturning(false);
        setError(String(reason));
        return;
      }
      const buffer = currentBufferRef.current;
      if (!buffer || buffer.saving) {
        returningRef.current = false;
        setReturning(false);
        setError(t("workspaceFiles.loadingFile"));
        return;
      }
      if (returnTimeoutRef.current !== null) {
        window.clearTimeout(returnTimeoutRef.current);
      }
      returnTimeoutRef.current = window.setTimeout(() => {
        returnTimeoutRef.current = null;
        returningRef.current = false;
        setReturning(false);
        setError(t("pty.returnFailed", { error: t("pty.returnTimedOut") }));
      }, WORKSPACE_CONTENT_WINDOW_HANDOFF_TIMEOUT_MS);
      await emitWorkspaceContentWindowEvent(
        "main",
        "workspace-file-window-return-requested",
        {
          documentId,
          token,
          windowLabel: getCurrentWindow().label,
          targetPaneId,
          fileDocument,
          fileBuffer: buffer,
        },
      ).catch((reason) => {
        if (returnTimeoutRef.current !== null) {
          window.clearTimeout(returnTimeoutRef.current);
          returnTimeoutRef.current = null;
        }
        returningRef.current = false;
        setReturning(false);
        setError(String(reason));
      });
    },
    [documentId, fileDocument, t, token],
  );
  const requestReturnRef = useRef(requestReturn);
  requestReturnRef.current = requestReturn;

  const saveFile = useCallback(
    () =>
      fileOperationFlightsRef.current.save(documentId, async () => {
        if (returningRef.current || !fileDocument) return;
        const buffer = currentBufferRef.current;
        if (
          !buffer ||
          buffer.kind !== "text" ||
          buffer.identityChanged === true ||
          buffer.saving ||
          buffer.content === buffer.savedContent
        ) {
          return;
        }
        const submitted = beginWorkspaceFileSave(buffer);
        updateFileBuffer(() => submitted);
        try {
          const saved = await saveProjectTextFile(
            fileDocument.directoryId,
            fileDocument.directoryPath,
            fileDocument.relativePath,
            submitted.content,
            submitted.revision,
          );
          if (currentBufferRef.current?.epoch !== submitted.epoch) return;
          if (saved.kind === "conflict") {
            updateFileBuffer((current) =>
              markWorkspaceFileSaveConflict(current, submitted),
            );
            setError(t("workspaceFiles.saveConflict"));
            return;
          }
          updateFileBuffer((current) =>
            completeWorkspaceFileSave(current, submitted, saved),
          );
        } catch (reason) {
          if (currentBufferRef.current?.epoch !== submitted.epoch) return;
          if (isProjectIdentityChangedError(reason)) {
            updateFileBuffer((current) =>
              current ? markWorkspaceFileIdentityChanged(current) : current,
            );
            setError(t("workspaceFiles.projectIdentityChanged"));
            return;
          }
          updateFileBuffer((current) =>
            failWorkspaceFileSave(current, submitted),
          );
          setError(getAppErrorMessage(reason));
        }
      }),
    [documentId, fileDocument, t, updateFileBuffer],
  );

  const reloadFile = useCallback(
    () =>
      fileOperationFlightsRef.current.load(documentId, async () => {
        await fileOperationFlightsRef.current.waitForSave(documentId);
        const startingBuffer = currentBufferRef.current;
        if (!fileDocument || !startingBuffer || returningRef.current) return;
        try {
          const loaded = createWorkspaceFileBuffer(
            await openProjectFile(
              fileDocument.directoryId,
              fileDocument.directoryPath,
              fileDocument.relativePath,
            ),
            startingBuffer.epoch + 1,
          );
          const current = currentBufferRef.current;
          if (
            current?.epoch !== startingBuffer.epoch ||
            current.version !== startingBuffer.version ||
            fileDocument.id !== documentId ||
            returningRef.current
          ) {
            return;
          }
          updateFileBuffer(() => loaded);
          setError(null);
        } catch (reason) {
          if (isProjectIdentityChangedError(reason)) {
            updateFileBuffer((current) =>
              current ? markWorkspaceFileIdentityChanged(current) : current,
            );
            setError(t("workspaceFiles.projectIdentityChanged"));
            return;
          }
          setError(getAppErrorMessage(reason));
        }
      }),
    [documentId, fileDocument, t, updateFileBuffer],
  );

  useEffect(() => {
    let disposed = false;
    const stops: (() => void)[] = [];
    const setup = async () => {
      const currentWindow = getCurrentWindow();
      await completeWorkspaceFileWindowSetup({
        registerListeners: () =>
          Promise.all([
            listenWorkspaceContentWindowEvent(
              "workspace-file-window-init",
              async (event) => {
                const message = event.payload;
                if (
                  message.documentId !== documentId ||
                  message.token !== token ||
                  message.windowLabel !== currentWindow.label ||
                  !message.fileDocument ||
                  !message.fileBuffer
                ) {
                  return;
                }
                const driverContext: WorkspaceContentHandoffHookContext<"file"> =
                  {
                    content: { kind: "file", documentId },
                    source: {
                      kind: "pane",
                      windowLabel: "main",
                      paneId: sourcePaneId,
                    },
                    target: {
                      kind: "window",
                      windowLabel: currentWindow.label,
                    },
                    transferId: token,
                    generation: 1,
                    capabilities: {
                      prepare: async () => ({
                        document: message.fileDocument,
                        buffer: message.fileBuffer,
                      }),
                      attach: async (payload) => {
                        fileDocumentRef.current = payload.document;
                        setFileDocument(payload.document);
                        updateFileBuffer(() => payload.buffer);
                      },
                      rollback: async () => undefined,
                    },
                  };
                try {
                  await attachWorkspaceContentHandoff(driverContext, {
                    document: message.fileDocument,
                    buffer: message.fileBuffer,
                  });
                } catch (reason) {
                  setError(String(reason));
                  await emitWorkspaceContentWindowEvent(
                    "main",
                    "workspace-file-window-attach-failed",
                    {
                      documentId,
                      token,
                      windowLabel: currentWindow.label,
                      message: String(reason),
                    },
                  );
                  return;
                }
                void emitWorkspaceContentWindowEvent(
                  "main",
                  "workspace-file-window-attached",
                  {
                    documentId,
                    token,
                    windowLabel: currentWindow.label,
                  },
                );
              },
            ),
            listenWorkspaceContentWindowEvent(
              "workspace-file-window-return-complete",
              (event) => {
                if (
                  event.payload.documentId !== documentId ||
                  event.payload.token !== token
                ) {
                  return;
                }
                if (returnTimeoutRef.current !== null) {
                  window.clearTimeout(returnTimeoutRef.current);
                  returnTimeoutRef.current = null;
                }
                void currentWindow.destroy();
              },
            ),
            listenWorkspaceContentWindowEvent(
              "workspace-file-window-flush-requested",
              (event) => {
                const request = event.payload;
                const document = fileDocumentRef.current;
                const buffer = currentBufferRef.current;
                if (
                  request.documentId !== documentId ||
                  request.token !== token ||
                  request.windowLabel !== currentWindow.label ||
                  !document ||
                  !buffer
                ) {
                  return;
                }
                void emitWorkspaceContentWindowEvent(
                  "main",
                  "workspace-file-window-flush-complete",
                  {
                    documentId,
                    token,
                    windowLabel: currentWindow.label,
                    requestId: request.requestId,
                    fileDocument: document,
                    fileBuffer: buffer,
                  },
                );
              },
            ),
            listenWorkspaceContentWindowEvent(
              "workspace-file-window-return-failed",
              (event) => {
                if (
                  event.payload.documentId !== documentId ||
                  event.payload.token !== token
                ) {
                  return;
                }
                if (returnTimeoutRef.current !== null) {
                  window.clearTimeout(returnTimeoutRef.current);
                  returnTimeoutRef.current = null;
                }
                returningRef.current = false;
                setReturning(false);
                setError(
                  event.payload.message ??
                    t("pty.returnFailed", {
                      error: t("pty.workspaceRestoring"),
                    }),
                );
              },
            ),
            listenWorkspaceContentWindowEvent(
              "workspace-file-window-return-drop-requested",
              (event) => {
                if (event.payload.documentId === documentId) {
                  void requestReturnRef.current(event.payload.targetPaneId);
                }
              },
            ),
          ]),
        isDisposed: () => disposed,
        keepListeners: (registered) => stops.push(...registered),
        sendReady: () =>
          emitWorkspaceContentWindowEvent(
            "main",
            "workspace-file-window-ready",
            {
              documentId,
              token,
              windowLabel: currentWindow.label,
            },
          ),
      });
    };
    void setup().catch((reason) => {
      if (!disposed) setError(String(reason));
    });
    return () => {
      disposed = true;
      stops.forEach((stop) => stop());
      bufferPublisherRef.current?.dispose();
      if (returnTimeoutRef.current !== null) {
        window.clearTimeout(returnTimeoutRef.current);
      }
    };
  }, [documentId, sourcePaneId, t, token]);

  const title = fileDocument?.relativePath ?? t("workspaceFiles.loadingFile");
  return (
    <WorkspaceContentWindowShell
      beforeClose={
        getWorkspaceContentAdapter("file").lifecycle?.beforeWindowClose
      }
      isReady={Boolean(fileDocument && fileBuffer)}
      onCloseBeforeReady={() => {
        const currentWindow = getCurrentWindow();
        void emitWorkspaceContentWindowEvent(
          "main",
          "workspace-file-window-attach-failed",
          {
            documentId,
            token,
            windowLabel: currentWindow.label,
            reason: "closed-before-ready",
          },
        )
          .catch((reason) =>
            console.warn(
              "Unable to report pre-ready file window close",
              reason,
            ),
          )
          .finally(() => currentWindow.destroy())
          .catch((reason) =>
            console.warn("Unable to destroy pre-ready file window", reason),
          );
      }}
      onCloseRequested={() => void requestReturnRef.current()}
      actions={
        <button
          type="button"
          className="ghost-button standalone-pty-return window-titlebar-compact-button"
          disabled={!fileBuffer || returning}
          onClick={() => void requestReturnRef.current()}
          title={t("pty.returnToWorkspace")}
        >
          <ArrowLeft size={15} />
          {t("pty.returnToWorkspace")}
        </button>
      }
      draggable={Boolean(fileBuffer) && !returning}
      onDragStart={(event) => {
        if (!fileDocument || !fileBuffer || returning) {
          event.preventDefault();
          return;
        }
        const payload = encodeWorkspaceContentDrag({
          kind: "file",
          contentId: documentId,
          sourceWindowLabel: getCurrentWindow().label,
        });
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(WORKSPACE_CONTENT_DRAG_TYPE, payload);
        event.dataTransfer.setData("text/plain", payload);
      }}
      title={
        <>
          <FileText size={16} />
          <strong>{title}</strong>
        </>
      }
    >
      <div className="standalone-pty-content">
        {fileDocument && fileBuffer ? (
          <WorkspaceContentView
            content={{ kind: "file", documentId }}
            fileDocument={fileDocument}
            fileBuffer={fileBuffer}
            readOnly={returning}
            onEditFile={(_id, content) => {
              if (returningRef.current) return;
              updateFileBuffer((current) =>
                current ? editWorkspaceFileBuffer(current, content) : current,
              );
            }}
            onSaveFile={saveFile}
          />
        ) : (
          <p className="standalone-pty-status">
            {t("workspaceFiles.loadingFile")}
          </p>
        )}
        {error && (
          <div className="error standalone-pty-error">
            {error}
            {fileBuffer?.conflict && (
              <button type="button" onClick={() => void reloadFile()}>
                {t("workspaceFiles.reload")}
              </button>
            )}
          </div>
        )}
      </div>
    </WorkspaceContentWindowShell>
  );
}

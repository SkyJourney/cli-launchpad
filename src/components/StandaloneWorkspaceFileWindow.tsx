import { getCurrentWindow } from "@tauri-apps/api/window";
import { ArrowLeft, FileText } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WorkspaceFileDocument } from "../lib/tauri";
import { openGrantedFile, saveGrantedTextFile } from "../lib/tauri";
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
  formatAppError,
  formatAppErrorState,
  toAppErrorState,
  isProjectIdentityChangedError,
} from "../lib/appErrors";
import {
  WorkspaceContentView,
  tryGetWorkspaceContentAdapter,
} from "./WorkspaceContentView";
import { WorkspaceContentWindowShell } from "./WorkspaceContentWindowShell";
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
import { registerAllOrCleanup } from "../lib/workspaceContentListenerSetup";
import { completeWorkspaceFileWindowSetup } from "../lib/workspaceFileWindowSetup";
import { useDetachedContentWindow } from "../workspace/windows/useDetachedContentWindow";

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
  const tRef = useRef(t);
  tRef.current = t;
  const windowKit = useDetachedContentWindow("file", documentId);
  const {
    returning,
    error,
    setReturning,
    setError,
    isReturning,
    returnTimer,
    destroyWindow,
    createDragStartHandler,
  } = windowKit;
  const [fileDocument, setFileDocument] = useState<WorkspaceFileDocument>();
  const [fileBuffer, setFileBuffer] = useState<WorkspaceFileBuffer>();
  const [saveWarning, setSaveWarning] = useState<string | null>(null);
  const fileDocumentRef = useRef<WorkspaceFileDocument | undefined>(undefined);
  const currentBufferRef = useRef<WorkspaceFileBuffer | undefined>(undefined);
  const bufferPublisherRef = useRef<ReturnType<
    typeof createWorkspaceFileBufferPublisher
  > | null>(null);
  const fileOperationFlightsRef = useRef(new WorkspaceFileOperationFlights());
  currentBufferRef.current = fileBuffer;
  fileDocumentRef.current = fileDocument;

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
      if (!fileDocument || !currentBufferRef.current || isReturning()) return;
      setReturning(true);
      setError(null);
      try {
        await fileOperationFlightsRef.current.waitForSave(documentId);
        await bufferPublisherRef.current?.flush();
      } catch (reason) {
        setReturning(false);
        setError(toAppErrorState(reason));
        return;
      }
      const buffer = currentBufferRef.current;
      if (!buffer || buffer.saving) {
        setReturning(false);
        setError({ message: tRef.current("workspaceFiles.loadingFile") });
        return;
      }
      returnTimer.arm(WORKSPACE_CONTENT_WINDOW_HANDOFF_TIMEOUT_MS, () => {
        setReturning(false);
        setError({
          message: tRef.current("pty.returnTimedOut"),
          wrapKey: "pty.returnFailed",
        });
      });
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
        returnTimer.clear();
        setReturning(false);
        setError(toAppErrorState(reason));
      });
    },
    [documentId, fileDocument, token],
  );
  const requestReturnRef = useRef(requestReturn);
  requestReturnRef.current = requestReturn;

  const saveFile = useCallback(
    () =>
      fileOperationFlightsRef.current.save(documentId, async () => {
        if (isReturning() || !fileDocument) return;
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
        setError(null);
        setSaveWarning(null);
        updateFileBuffer(() => submitted);
        try {
          const saved = await saveGrantedTextFile(
            submitted.content,
            submitted.revision,
          );
          if (currentBufferRef.current?.epoch !== submitted.epoch) return;
          if (saved.kind === "conflict") {
            updateFileBuffer((current) =>
              markWorkspaceFileSaveConflict(current, submitted),
            );
            setError({ message: tRef.current("workspaceFiles.saveConflict") });
            return;
          }
          updateFileBuffer((current) =>
            completeWorkspaceFileSave(current, submitted, saved),
          );
          if (saved.warning === "permissionsNotRestored") {
            setSaveWarning(
              tRef.current("workspaceFiles.permissionsNotRestored"),
            );
          }
        } catch (reason) {
          if (currentBufferRef.current?.epoch !== submitted.epoch) return;
          if (isProjectIdentityChangedError(reason)) {
            updateFileBuffer((current) =>
              current ? markWorkspaceFileIdentityChanged(current) : current,
            );
            setError({
              message: tRef.current("workspaceFiles.projectIdentityChanged"),
            });
            return;
          }
          updateFileBuffer((current) =>
            failWorkspaceFileSave(current, submitted),
          );
          setError(toAppErrorState(reason));
        }
      }),
    [documentId, fileDocument, updateFileBuffer],
  );

  const reloadFile = useCallback(
    () =>
      fileOperationFlightsRef.current.load(documentId, async () => {
        await fileOperationFlightsRef.current.waitForSave(documentId);
        const startingBuffer = currentBufferRef.current;
        if (!fileDocument || !startingBuffer || isReturning()) return;
        try {
          const loaded = createWorkspaceFileBuffer(
            await openGrantedFile(),
            startingBuffer.epoch + 1,
          );
          const current = currentBufferRef.current;
          if (
            current?.epoch !== startingBuffer.epoch ||
            current.version !== startingBuffer.version ||
            fileDocument.id !== documentId ||
            isReturning()
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
            setError({
              message: tRef.current("workspaceFiles.projectIdentityChanged"),
            });
            return;
          }
          setError(toAppErrorState(reason));
        }
      }),
    [documentId, fileDocument, updateFileBuffer],
  );

  useEffect(() => {
    let disposed = false;
    const stops: (() => void)[] = [];
    const setup = async () => {
      const currentWindow = getCurrentWindow();
      await completeWorkspaceFileWindowSetup({
        registerListeners: () =>
          registerAllOrCleanup([
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
                  setError(toAppErrorState(reason));
                  await emitWorkspaceContentWindowEvent(
                    "main",
                    "workspace-file-window-attach-failed",
                    {
                      documentId,
                      token,
                      windowLabel: currentWindow.label,
                      message: formatAppError(reason, tRef.current),
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
                returnTimer.clear();
                void destroyWindow("Failed to destroy returned file window");
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
                returnTimer.clear();
                setReturning(false);
                setError(
                  event.payload.message != null
                    ? { message: event.payload.message }
                    : {
                        message: tRef.current("pty.workspaceRestoring"),
                        wrapKey: "pty.returnFailed",
                      },
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
      if (disposed) return;
      const message = formatAppError(reason, tRef.current);
      setError(toAppErrorState(reason));
      void emitWorkspaceContentWindowEvent(
        "main",
        "workspace-file-window-attach-failed",
        {
          documentId,
          token,
          windowLabel: getCurrentWindow().label,
          message,
        },
      ).catch((emitError) =>
        console.warn("Unable to report file window setup failure", emitError),
      );
    });
    return () => {
      disposed = true;
      stops.forEach((stop) => stop());
      bufferPublisherRef.current?.dispose();
    };
  }, [documentId, sourcePaneId, token]);

  const title = fileDocument?.relativePath ?? t("workspaceFiles.loadingFile");
  return (
    <WorkspaceContentWindowShell
      beforeClose={
        tryGetWorkspaceContentAdapter("file")?.lifecycle?.beforeWindowClose
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
          .finally(() =>
            destroyWindow("Unable to destroy pre-ready file window"),
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
      onDragStart={createDragStartHandler(
        () => Boolean(fileDocument && fileBuffer) && !returning,
      )}
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
              if (isReturning()) return;
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
            {formatAppErrorState(error, t)}
            {fileBuffer?.conflict && (
              <button type="button" onClick={() => void reloadFile()}>
                {t("workspaceFiles.reload")}
              </button>
            )}
          </div>
        )}
        {saveWarning && (
          <p className="muted standalone-pty-error">{saveWarning}</p>
        )}
      </div>
    </WorkspaceContentWindowShell>
  );
}

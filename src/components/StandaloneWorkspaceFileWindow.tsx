import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ArrowLeft, FileText } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WorkspaceFileDocument } from "../lib/tauri";
import { saveProjectTextFile } from "../lib/tauri";
import {
  completeWorkspaceFileSave,
  failWorkspaceFileSave,
  type WorkspaceFileBuffer,
} from "../lib/workspaceFileBuffer";
import {
  encodeWorkspaceContentDrag,
  WORKSPACE_CONTENT_DRAG_TYPE,
} from "../lib/workspaceContentDrag";
import { WorkspaceContentView } from "./WorkspaceContentView";
import { WorkspaceContentWindowShell } from "./WorkspaceContentWindowShell";
import { getWorkspaceContentAdapter } from "./WorkspaceContentView";

interface WorkspaceFileWindowMessage {
  documentId: string;
  token: string;
  windowLabel: string;
  targetPaneId?: string;
  fileDocument?: WorkspaceFileDocument;
  fileBuffer?: WorkspaceFileBuffer;
  message?: string;
}

export function StandaloneWorkspaceFileWindow({
  documentId,
  token,
}: {
  documentId: string;
  token: string;
}) {
  const { t } = useTranslation();
  const [fileDocument, setFileDocument] = useState<WorkspaceFileDocument>();
  const [fileBuffer, setFileBuffer] = useState<WorkspaceFileBuffer>();
  const [returning, setReturning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currentBufferRef = useRef<WorkspaceFileBuffer | undefined>(undefined);
  const returningRef = useRef(false);
  const returnTimeoutRef = useRef<number | null>(null);
  currentBufferRef.current = fileBuffer;
  returningRef.current = returning;

  const requestReturn = useCallback(
    async (targetPaneId?: string) => {
      const buffer = currentBufferRef.current;
      if (!fileDocument || !buffer || returningRef.current) return;
      returningRef.current = true;
      setReturning(true);
      setError(null);
      if (returnTimeoutRef.current !== null) {
        window.clearTimeout(returnTimeoutRef.current);
      }
      returnTimeoutRef.current = window.setTimeout(() => {
        returnTimeoutRef.current = null;
        returningRef.current = false;
        setReturning(false);
        setError(t("pty.returnFailed", { error: t("pty.returnTimedOut") }));
      }, 15_000);
      await emitTo("main", "workspace-file-window-return-requested", {
        documentId,
        token,
        windowLabel: getCurrentWindow().label,
        targetPaneId,
        fileDocument,
        fileBuffer: buffer,
      } satisfies WorkspaceFileWindowMessage).catch((reason) => {
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

  const saveFile = useCallback(async () => {
    if (!fileDocument || !fileBuffer) return;
    const submitted = { ...fileBuffer, saving: true };
    setFileBuffer(submitted);
    try {
      const saved = await saveProjectTextFile(
        fileDocument.directoryId,
        fileDocument.relativePath,
        submitted.content,
        submitted.revision,
      );
      setFileBuffer((current) => {
        const next = completeWorkspaceFileSave(current, submitted, saved);
        void emitTo("main", "workspace-file-window-buffer-changed", {
          documentId,
          token,
          windowLabel: getCurrentWindow().label,
          fileDocument,
          fileBuffer: next,
        } satisfies WorkspaceFileWindowMessage);
        return next;
      });
    } catch (reason) {
      setFileBuffer((current) => failWorkspaceFileSave(current, submitted));
      setError(String(reason));
    }
  }, [documentId, fileBuffer, fileDocument, token]);

  useEffect(() => {
    let disposed = false;
    const stops: (() => void)[] = [];
    const setup = async () => {
      const currentWindow = getCurrentWindow();
      const registered = await Promise.all([
        listen<WorkspaceFileWindowMessage>(
          "workspace-file-window-init",
          (event) => {
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
            setFileDocument(message.fileDocument);
            setFileBuffer(message.fileBuffer);
            void emitTo("main", "workspace-file-window-attached", {
              documentId,
              token,
              windowLabel: currentWindow.label,
            });
          },
        ),
        listen<WorkspaceFileWindowMessage>(
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
        listen<WorkspaceFileWindowMessage>(
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
                t("pty.returnFailed", { error: t("pty.workspaceRestoring") }),
            );
          },
        ),
        listen<{ documentId: string; targetPaneId: string }>(
          "workspace-file-window-return-drop-requested",
          (event) => {
            if (event.payload.documentId === documentId) {
              void requestReturnRef.current(event.payload.targetPaneId);
            }
          },
        ),
      ]);
      if (disposed) registered.forEach((stop) => stop());
      else stops.push(...registered);
      await emitTo("main", "workspace-file-window-ready", {
        documentId,
        token,
        windowLabel: currentWindow.label,
      });
    };
    void setup().catch((reason) => setError(String(reason)));
    return () => {
      disposed = true;
      stops.forEach((stop) => stop());
      if (returnTimeoutRef.current !== null) {
        window.clearTimeout(returnTimeoutRef.current);
      }
    };
  }, [documentId, t, token]);

  useEffect(() => {
    if (!fileDocument || !fileBuffer) return;
    void emitTo("main", "workspace-file-window-buffer-changed", {
      documentId,
      token,
      windowLabel: getCurrentWindow().label,
      fileDocument,
      fileBuffer,
    } satisfies WorkspaceFileWindowMessage);
  }, [documentId, fileBuffer, fileDocument, token]);

  const title = fileDocument?.relativePath ?? t("workspaceFiles.loadingFile");
  return (
    <WorkspaceContentWindowShell
      beforeClose={getWorkspaceContentAdapter("file").beforeWindowClose}
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
            onEditFile={(_id, content) =>
              setFileBuffer((current) =>
                current ? { ...current, content } : current,
              )
            }
            onSaveFile={saveFile}
          />
        ) : (
          <p className="standalone-pty-status">
            {t("workspaceFiles.loadingFile")}
          </p>
        )}
        {error && <p className="error standalone-pty-error">{error}</p>}
      </div>
    </WorkspaceContentWindowShell>
  );
}

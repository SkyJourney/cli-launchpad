import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Save } from "lucide-react";
import { useTranslation } from "react-i18next";
import { WorkspaceEditorSurface } from "../WorkspaceEditorSurface";
import type { WorkspaceFileDocument } from "../../lib/tauri";
import type { WorkspaceFileBuffer } from "../../lib/workspaceFileBuffer";
import type { WorkspaceContentAdapter } from "../workspaceContentAdapterRegistry";
import { registerWorkspaceContentAdapter } from "../workspaceContentAdapterRegistry";
import { createWorkspaceEditorModelUri } from "../../lib/workspaceEditorModel";

const unsupportedReasonKeys = {
  binary: "workspaceFiles.unsupported.binary",
  tooLarge: "workspaceFiles.unsupported.tooLarge",
  invalidImage: "workspaceFiles.unsupported.invalidImage",
  unsupportedImage: "workspaceFiles.unsupported.unsupportedImage",
} as const;

function PtyContentAdapter({ portalTarget }: { portalTarget?: HTMLElement }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || !portalTarget) return;
    portalTarget.hidden = false;
    host.append(portalTarget);
    return () => {
      portalTarget.hidden = true;
      if (portalTarget.parentElement === host) portalTarget.remove();
    };
  }, [portalTarget]);

  return <div ref={hostRef} className="workspace-content-renderer" />;
}

function TextFileContentAdapter({
  fileDocument,
  fileBuffer,
  readOnly,
  onEditFile,
  onSaveFile,
}: {
  fileDocument: WorkspaceFileDocument | undefined;
  fileBuffer: WorkspaceFileBuffer | undefined;
  readOnly: boolean;
  onEditFile: (documentId: string, content: string) => void;
  onSaveFile: (documentId: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    document.documentElement.dataset.theme === "light" ? "light" : "dark",
  );

  useEffect(() => {
    const root = document.documentElement;
    const updateTheme = () =>
      setTheme(root.dataset.theme === "light" ? "light" : "dark");
    const observer = new MutationObserver(updateTheme);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    updateTheme();
    return () => observer.disconnect();
  }, []);

  if (!fileDocument) return null;

  if (!fileBuffer) {
    return (
      <div className="pty-workspace-empty" role="status">
        {t("workspaceFiles.loadingFile")}
      </div>
    );
  }
  if (fileBuffer.kind === "image") {
    return (
      <div className="workspace-file-preview">
        <div
          className="workspace-file-preview-path"
          title={fileDocument.relativePath}
        >
          {fileDocument.relativePath}
        </div>
        <div className="workspace-image-preview-stage">
          <img
            src={fileBuffer.previewDataUrl}
            alt={t("workspaceFiles.imagePreview")}
          />
        </div>
      </div>
    );
  }
  if (fileBuffer.kind === "unsupported") {
    return (
      <div className="workspace-file-preview">
        <div
          className="workspace-file-preview-path"
          title={fileDocument.relativePath}
        >
          {fileDocument.relativePath}
        </div>
        <div className="workspace-file-unavailable" role="status">
          <strong>{t("workspaceFiles.fileCannotOpen")}</strong>
          <span>
            {t(unsupportedReasonKeys[fileBuffer.unsupportedReason ?? "binary"])}
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className="workspace-text-editor">
      {fileBuffer.conflict && (
        <div className="workspace-file-conflict" role="alert">
          {fileBuffer.identityChanged
            ? t("workspaceFiles.projectIdentityChanged")
            : t("workspaceFiles.saveConflict")}
        </div>
      )}
      <div className="workspace-text-editor-toolbar">
        <span title={fileDocument.relativePath}>
          {fileDocument.relativePath}
        </span>
        <button
          type="button"
          className="icon-button workspace-text-editor-save"
          disabled={
            readOnly ||
            fileBuffer.identityChanged === true ||
            fileBuffer.saving ||
            fileBuffer.content === fileBuffer.savedContent
          }
          onClick={() => void onSaveFile(fileDocument.id)}
        >
          <Save size={14} /> {t("workspaceFiles.save")}
        </button>
      </div>
      <WorkspaceEditorSurface
        value={fileBuffer.content}
        relativePath={fileDocument.relativePath}
        modelUri={createWorkspaceEditorModelUri(
          fileDocument.directoryId,
          fileDocument.relativePath,
        )}
        theme={theme}
        readOnly={readOnly}
        onChange={(content) => onEditFile(fileDocument.id, content)}
        onSave={() => void onSaveFile(fileDocument.id)}
      />
    </div>
  );
}

const ptyAdapter: WorkspaceContentAdapter<"pty"> = {
  id: "core.pty",
  apiVersion: 1,
  kind: "pty",
  render: (context) => {
    if (context.content.kind !== "pty") return null;
    return <PtyContentAdapter portalTarget={context.pty?.portalTarget} />;
  },
  lifecycle: {
    prepareHandoff: async ({ capabilities }) => {
      const payload = await capabilities.prepare();
      return { transferId: payload.handoff.token, payload };
    },
    attachHandoff: ({ capabilities }, payload) => capabilities.attach(payload),
    rollbackHandoff: ({ capabilities }, payload, reason) =>
      capabilities.rollback(payload, reason),
  },
  presentation: {
    labels: {
      menu: "pty.sessionMenu",
      close: "pty.close",
      closeCurrent: "pty.closeCurrent",
      closeOthers: "pty.closeOthers",
      closeAll: "pty.closeAllInPane",
      splitAndMoveRight: "pty.splitAndMoveRight",
      splitAndMoveDown: "pty.splitAndMoveDown",
    },
  },
};

const fileAdapter: WorkspaceContentAdapter<"file"> = {
  id: "core.file-editor",
  apiVersion: 1,
  kind: "file",
  render: (context) => {
    if (context.content.kind !== "file" || !context.file?.document) {
      return null;
    }
    return (
      <TextFileContentAdapter
        fileDocument={context.file.document}
        fileBuffer={context.file.buffer}
        readOnly={context.file.readOnly}
        onEditFile={context.file.edit}
        onSaveFile={context.file.save}
      />
    );
  },
  lifecycle: {
    beforeClose: ({ isDirty, confirmDiscard }) => !isDirty || confirmDiscard(),
    prepareHandoff: async ({ transferId, capabilities }) => ({
      transferId,
      payload: await capabilities.prepare(),
    }),
    attachHandoff: ({ capabilities }, payload) => capabilities.attach(payload),
    rollbackHandoff: ({ capabilities }, payload, reason) =>
      capabilities.rollback(payload, reason),
  },
  presentation: {
    labels: {
      menu: "workspaceFiles.fileMenu",
      close: "workspaceFiles.closeFile",
      closeCurrent: "workspaceFiles.closeFileNamed",
      closeOthers: "workspaceFiles.closeOthers",
      closeAll: "workspaceFiles.closeAllInPane",
      splitAndMoveRight: "workspaceFiles.splitAndMoveRight",
      splitAndMoveDown: "workspaceFiles.splitAndMoveDown",
    },
  },
};

export function registerBuiltinWorkspaceContentAdapters(): () => void {
  const unregister = [
    registerWorkspaceContentAdapter(ptyAdapter),
    registerWorkspaceContentAdapter(fileAdapter),
  ];
  return () => unregister.reverse().forEach((dispose) => dispose());
}

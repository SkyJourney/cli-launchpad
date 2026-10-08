import { Component, useSyncExternalStore, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { WorkspacePaneContentRef } from "../lib/tauri";
import type { WorkspaceFileDocument } from "../lib/tauri";
import type { WorkspaceFileBuffer } from "../lib/workspaceFileBuffer";
import {
  getWorkspaceContentAdapterRevision,
  subscribeWorkspaceContentAdapters,
  tryGetWorkspaceContentAdapter,
  type WorkspaceContentAdapter,
  type WorkspaceContentRenderContext,
} from "./workspaceContentAdapterRegistry";

export {
  getWorkspaceContentAdapter,
  tryGetWorkspaceContentAdapter,
  presentWorkspaceContent,
  registerWorkspaceContentAdapter,
  workspaceContentProjectContext,
} from "./workspaceContentAdapterRegistry";
export type {
  WorkspaceContentAdapter,
  WorkspaceContentAdapterLabels,
  WorkspaceContentAdapterLifecycle,
  WorkspaceContentHandoffHookContext,
  WorkspaceContentPresentationContext,
  WorkspaceContentRenderContext,
} from "./workspaceContentAdapterRegistry";

export function WorkspaceContentView({
  content,
  fileDocument,
  fileBuffer,
  readOnly = false,
  ptyPortalTarget,
  onEditFile,
  onSaveFile,
  onCloseUnsupported,
}: {
  content: WorkspacePaneContentRef | null | undefined;
  fileDocument: WorkspaceFileDocument | undefined;
  fileBuffer: WorkspaceFileBuffer | undefined;
  readOnly?: boolean;
  ptyPortalTarget?: HTMLElement;
  onEditFile: (documentId: string, content: string) => void;
  onSaveFile: (documentId: string) => Promise<void>;
  onCloseUnsupported?: () => void;
}) {
  useSyncExternalStore(
    subscribeWorkspaceContentAdapters,
    getWorkspaceContentAdapterRevision,
    getWorkspaceContentAdapterRevision,
  );
  if (!content) return null;
  if (content.kind === "unknown") {
    return (
      <UnsupportedContentPlaceholder
        kind={content.originalKind}
        onClose={onCloseUnsupported}
      />
    );
  }
  const adapter = tryGetWorkspaceContentAdapter(content.kind);
  if (!adapter) {
    return (
      <UnsupportedContentPlaceholder
        kind={content.kind}
        onClose={onCloseUnsupported}
      />
    );
  }
  const renderContext: WorkspaceContentRenderContext = {
    content,
    ...(content.kind === "pty"
      ? { pty: { portalTarget: ptyPortalTarget } }
      : {}),
    ...(content.kind === "file"
      ? {
          file: {
            document: fileDocument,
            buffer: fileBuffer,
            readOnly,
            edit: onEditFile,
            save: onSaveFile,
          },
        }
      : {}),
  };
  return (
    <WorkspaceContentErrorBoundary
      key={workspaceContentErrorBoundaryKey(content)}
      kind={content.kind}
      onClose={onCloseUnsupported}
    >
      <WorkspaceContentAdapterRenderer
        adapter={adapter}
        context={renderContext}
      />
    </WorkspaceContentErrorBoundary>
  );
}

function WorkspaceContentAdapterRenderer({
  adapter,
  context,
}: {
  adapter: WorkspaceContentAdapter;
  context: WorkspaceContentRenderContext;
}) {
  return adapter.render(context);
}

class WorkspaceContentErrorBoundary extends Component<
  {
    kind: string;
    onClose?: () => void;
    children: ReactNode;
  },
  { hasError: boolean; errorMessage: string }
> {
  state = { hasError: false, errorMessage: "" };

  static getDerivedStateFromError(error: unknown) {
    // 空值不带文案：占位组件在 error 为空时会显示已本地化的通用描述。
    const message =
      error instanceof Error ? error.message : String(error ?? "");
    return { hasError: true, errorMessage: message.slice(0, 200) };
  }

  render() {
    return this.state.hasError ? (
      <UnsupportedContentPlaceholder
        kind={this.props.kind}
        error={this.state.errorMessage}
        onClose={this.props.onClose}
      />
    ) : (
      this.props.children
    );
  }
}

function workspaceContentErrorBoundaryKey(content: WorkspacePaneContentRef) {
  if (content.kind === "pty") return `pty:${content.slotId}`;
  if (content.kind === "file") return `file:${content.documentId}`;
  return `unknown:${content.originalKind}:${JSON.stringify(content.raw)}`;
}

function UnsupportedContentPlaceholder({
  kind,
  error,
  onClose,
}: {
  kind: string;
  error?: string;
  onClose?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="workspace-content-unsupported" role="alert">
      <strong>{t("workspaceContent.unsupportedTitle", { kind })}</strong>
      <p>
        {error
          ? t("workspaceContent.unsupportedError", { error })
          : t("workspaceContent.unsupportedDescription")}
      </p>
      {onClose && (
        <button type="button" onClick={onClose}>
          {t("workspaceContent.closeUnsupported")}
        </button>
      )}
    </section>
  );
}

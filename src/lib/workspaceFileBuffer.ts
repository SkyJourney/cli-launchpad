import type { ProjectFileOpenResult } from "./tauri";

export interface WorkspaceFileBuffer {
  kind?: "text" | "image" | "unsupported";
  content: string;
  savedContent: string;
  revision: string;
  saving: boolean;
  previewDataUrl?: string;
  unsupportedReason?: Extract<
    ProjectFileOpenResult,
    { kind: "unsupported" }
  >["reason"];
}

export function createWorkspaceFileBuffer(
  file: ProjectFileOpenResult,
): WorkspaceFileBuffer {
  if (file.kind === "text") {
    return {
      kind: "text",
      content: file.content,
      savedContent: file.content,
      revision: file.revision,
      saving: false,
    };
  }
  if (file.kind === "image") {
    return {
      kind: "image",
      content: "",
      savedContent: "",
      revision: "",
      saving: false,
      previewDataUrl: `data:${file.mimeType};base64,${file.base64Data}`,
    };
  }
  return {
    kind: "unsupported",
    content: "",
    savedContent: "",
    revision: "",
    saving: false,
    unsupportedReason: file.reason,
  };
}

export interface WorkspaceFileSaveResult {
  content: string;
  revision: string;
}

export function completeWorkspaceFileSave(
  current: WorkspaceFileBuffer | undefined,
  submitted: WorkspaceFileBuffer,
  result: WorkspaceFileSaveResult,
): WorkspaceFileBuffer {
  return {
    ...(current ?? submitted),
    content:
      current && current.content !== submitted.content
        ? current.content
        : result.content,
    savedContent: result.content,
    revision: result.revision,
    saving: false,
  };
}

export function failWorkspaceFileSave(
  current: WorkspaceFileBuffer | undefined,
  submitted: WorkspaceFileBuffer,
): WorkspaceFileBuffer {
  return { ...(current ?? submitted), saving: false };
}

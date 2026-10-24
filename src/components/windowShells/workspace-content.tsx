import { lazy } from "react";
import { readFileLaunchParams } from "../../workspace/windows/windowLaunchParams";
import type { WindowShellProps } from "./types";

const StandaloneWorkspaceFileWindow = lazy(() =>
  import("../StandaloneWorkspaceFileWindow").then((module) => ({
    default: module.StandaloneWorkspaceFileWindow,
  })),
);

export default function WorkspaceContentShell({ search }: WindowShellProps) {
  const params = readFileLaunchParams(search);
  if (!params) return null;
  return (
    <StandaloneWorkspaceFileWindow
      documentId={params.documentId}
      token={params.windowToken}
      sourcePaneId={params.sourcePaneId}
    />
  );
}

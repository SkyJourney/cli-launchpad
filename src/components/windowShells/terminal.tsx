import { lazy } from "react";
import { useTranslation } from "react-i18next";
import { readPtyLaunchParams } from "../../workspace/windows/windowLaunchParams";
import type { WindowShellProps } from "./types";

const StandalonePtyWindow = lazy(() =>
  import("../StandalonePtyWindow").then((module) => ({
    default: module.StandalonePtyWindow,
  })),
);

export default function TerminalShell({ search }: WindowShellProps) {
  const { t } = useTranslation();
  const params = readPtyLaunchParams(search);
  if (!params) return null;
  return (
    <StandalonePtyWindow
      sessionId={params.sessionId}
      handoffToken={params.handoffToken}
      instanceId={params.instanceId}
      sourcePaneId={params.sourcePaneId}
      toolKey={params.toolKey}
      title={params.title ?? t("pty.detachedDefaultTitle")}
    />
  );
}

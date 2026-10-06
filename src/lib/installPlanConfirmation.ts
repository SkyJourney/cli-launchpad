import type { InstallKind, InstallPlan, ToolKey } from "./tauri";

export interface InstallPlanConfirmation {
  toolKey: ToolKey;
  kind: InstallKind;
  plan: InstallPlan;
}

export function isInstallPlanChangedError(error: unknown): boolean {
  if (error === "plan_changed") return true;
  if (error instanceof Error) return error.message === "plan_changed";
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "plan_changed"
  );
}

export async function refreshInstallPlanConfirmation(args: {
  error: unknown;
  action: InstallPlanConfirmation;
  getPlan: (toolKey: ToolKey, kind: InstallKind) => Promise<InstallPlan>;
  setPending: (action: InstallPlanConfirmation) => void;
}): Promise<boolean> {
  if (!isInstallPlanChangedError(args.error)) return false;
  const plan = await args.getPlan(args.action.toolKey, args.action.kind);
  args.setPending({ ...args.action, plan });
  return true;
}

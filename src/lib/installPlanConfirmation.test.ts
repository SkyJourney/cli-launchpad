import { describe, expect, it, vi } from "vitest";
import {
  isInstallPlanChangedError,
  refreshInstallPlanConfirmation,
} from "./installPlanConfirmation";
import type { InstallPlan } from "./tauri";

const plan: InstallPlan = {
  toolKey: "codex",
  kind: "update",
  program: "codex",
  args: ["update"],
  fingerprint: "new-fingerprint",
  source: "native updater",
  preview: "codex update",
  effects: null,
};

describe("install plan confirmation refresh", () => {
  it("recognizes the typed plan_changed rejection", () => {
    expect(isInstallPlanChangedError("plan_changed")).toBe(true);
    expect(isInstallPlanChangedError(new Error("plan_changed"))).toBe(true);
    expect(isInstallPlanChangedError("network failure")).toBe(false);
  });

  it("fetches a new plan and reopens confirmation without starting execution", async () => {
    const action = { toolKey: "codex" as const, kind: "update" as const, plan };
    const getPlan = vi.fn(async () => plan);
    const setPending = vi.fn();

    await expect(
      refreshInstallPlanConfirmation({
        error: "plan_changed",
        action,
        getPlan,
        setPending,
      }),
    ).resolves.toBe(true);

    expect(getPlan).toHaveBeenCalledWith("codex", "update");
    expect(setPending).toHaveBeenCalledWith(action);
  });
});

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

  it("recognizes the coded IPC rejection shape", () => {
    expect(
      isInstallPlanChangedError({
        code: "plan_changed",
        message: "安装计划已变化",
      }),
    ).toBe(true);
    expect(
      isInstallPlanChangedError({ code: "other", message: "安装计划已变化" }),
    ).toBe(false);
  });

  it("reopens confirmation with the refreshed plan", async () => {
    const action = { toolKey: "codex" as const, kind: "update" as const, plan };
    const refreshedPlan = { ...plan, fingerprint: "fp-2" };
    const getPlan = vi.fn(async () => refreshedPlan);
    const setPending = vi.fn();

    await expect(
      refreshInstallPlanConfirmation({
        error: { code: "plan_changed", message: "安装计划已变化" },
        action,
        getPlan,
        setPending,
      }),
    ).resolves.toBe(true);

    expect(setPending).toHaveBeenCalledTimes(1);
    const reopened = setPending.mock.calls[0][0];
    expect(reopened.plan.fingerprint).toBe("fp-2");
    expect(reopened.plan.fingerprint).not.toBe(plan.fingerprint);
    expect(reopened.toolKey).toBe("codex");
    expect(reopened.kind).toBe("update");
  });
});

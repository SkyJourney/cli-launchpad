// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { useAppStore } from "../store/appStore";
import { subscribeResolvedTheme } from "./useResolvedTheme";

describe("resolved theme subscription", () => {
  it("publishes the shared theme snapshot only when its identity changes", () => {
    const listener = vi.fn();
    useAppStore.getState().setResolvedTheme({ id: "light", base: "light" });
    const unsubscribe = subscribeResolvedTheme(listener);

    useAppStore.getState().setResolvedTheme({ id: "dark", base: "dark" });
    useAppStore.getState().setResolvedTheme({ id: "dark", base: "dark" });
    unsubscribe();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ id: "dark", base: "dark" });
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  getWorkspaceContentAdapter,
  registerWorkspaceContentAdapter,
  subscribeWorkspaceContentAdapters,
} from "./workspaceContentAdapterRegistry";

const labels = {
  menu: "menu",
  close: "close",
  closeCurrent: "closeCurrent",
  closeOthers: "closeOthers",
  closeAll: "closeAll",
  splitAndMoveRight: "splitRight",
  splitAndMoveDown: "splitDown",
};

describe("workspace content adapter registry", () => {
  it("registers and resolves a built-in adapter by content kind", () => {
    const adapter = {
      id: "test.pty",
      apiVersion: 1 as const,
      kind: "pty" as const,
      render: () => null,
      labels,
    };
    const dispose = registerWorkspaceContentAdapter(adapter);

    expect(getWorkspaceContentAdapter("pty")).toBe(adapter);
    dispose();
    expect(() => getWorkspaceContentAdapter("pty")).toThrow(
      "未注册内容适配器: pty",
    );
  });

  it("rejects duplicate IDs and duplicate content kinds", () => {
    const first = registerWorkspaceContentAdapter({
      id: "test.first",
      apiVersion: 1,
      kind: "file",
      render: () => null,
      labels,
    });
    expect(() =>
      registerWorkspaceContentAdapter({
        id: "test.first",
        apiVersion: 1,
        kind: "pty",
        render: () => null,
        labels,
      }),
    ).toThrow("内容适配器 ID 已注册: test.first");
    expect(() =>
      registerWorkspaceContentAdapter({
        id: "test.second",
        apiVersion: 1,
        kind: "file",
        render: () => null,
        labels,
      }),
    ).toThrow("内容类型已注册: file");
    first();
  });

  it("notifies subscribers when registrations are added and removed", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeWorkspaceContentAdapters(listener);
    const dispose = registerWorkspaceContentAdapter({
      id: "test.notify",
      apiVersion: 1,
      kind: "pty",
      render: () => null,
      labels,
    });

    expect(listener).toHaveBeenCalledTimes(1);
    dispose();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});

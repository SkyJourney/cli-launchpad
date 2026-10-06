import { describe, expect, it, vi } from "vitest";
import { isValidElement } from "react";
import {
  getWorkspaceContentAdapter,
  registerWorkspaceContentAdapter,
  subscribeWorkspaceContentAdapters,
} from "./workspaceContentAdapterRegistry";
import { registerBuiltinWorkspaceContentAdapters } from "./workspaceContentAdapters/builtins";

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
  it("renders PTY content through the adapter with the injected portal target", () => {
    const unregister = registerBuiltinWorkspaceContentAdapters();
    const portalTarget = {} as HTMLElement;

    try {
      const view = getWorkspaceContentAdapter("pty").render({
        content: { kind: "pty", slotId: "terminal-a" },
        pty: { portalTarget },
      });

      expect(isValidElement(view)).toBe(true);
      expect(view).toMatchObject({ props: { portalTarget } });
    } finally {
      unregister();
    }
  });

  it("registers and resolves a built-in adapter by content kind", () => {
    const adapter = {
      id: "test.pty",
      apiVersion: 1 as const,
      kind: "pty" as const,
      render: () => null,
      presentation: () => ({
        title: "test",
        icon: null,
        closeLabelKey: "close",
      }),
      labels,
      projectContextOf: () => null,
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
      presentation: () => ({
        title: "test",
        icon: null,
        closeLabelKey: "close",
      }),
      labels,
      projectContextOf: () => null,
    });
    expect(() =>
      registerWorkspaceContentAdapter({
        id: "test.first",
        apiVersion: 1,
        kind: "pty",
        render: () => null,
        presentation: () => ({
          title: "test",
          icon: null,
          closeLabelKey: "close",
        }),
        labels,
        projectContextOf: () => null,
      }),
    ).toThrow("内容适配器 ID 已注册: test.first");
    expect(() =>
      registerWorkspaceContentAdapter({
        id: "test.second",
        apiVersion: 1,
        kind: "file",
        render: () => null,
        presentation: () => ({
          title: "test",
          icon: null,
          closeLabelKey: "close",
        }),
        labels,
        projectContextOf: () => null,
      }),
    ).toThrow("内容类型已注册: file");
    first();
  });

  it("rejects unsupported API versions", () => {
    expect(() =>
      registerWorkspaceContentAdapter({
        id: "test.unsupported-version",
        apiVersion: 2,
        kind: "pty",
        render: () => null,
        presentation: () => ({
          title: "test",
          icon: null,
          closeLabelKey: "close",
        }),
        labels,
        projectContextOf: () => null,
      } as unknown as Parameters<typeof registerWorkspaceContentAdapter>[0]),
    ).toThrow("不支持内容适配器 API 版本: 2");
  });

  it("notifies subscribers when registrations are added and removed", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeWorkspaceContentAdapters(listener);
    const dispose = registerWorkspaceContentAdapter({
      id: "test.notify",
      apiVersion: 1,
      kind: "pty",
      render: () => null,
      presentation: () => ({
        title: "test",
        icon: null,
        closeLabelKey: "close",
      }),
      labels,
      projectContextOf: () => null,
    });

    expect(listener).toHaveBeenCalledTimes(1);
    dispose();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("rejects a partially declared handoff lifecycle", () => {
    expect(() =>
      registerWorkspaceContentAdapter({
        id: "test.partial-handoff",
        apiVersion: 1,
        kind: "pty",
        render: () => null,
        presentation: () => ({
          title: "test",
          icon: null,
          closeLabelKey: "close",
        }),
        labels,
        projectContextOf: () => null,
        lifecycle: {
          prepareHandoff: async ({ transferId }) => ({
            transferId,
            payload: { handoff: { token: transferId, sequence: 1 } },
          }),
        },
      }),
    ).toThrow("内容适配器 handoff 生命周期钩子不完整: pty");
  });

  it("accepts a complete typed handoff lifecycle", () => {
    const dispose = registerWorkspaceContentAdapter({
      id: "test.complete-handoff",
      apiVersion: 1,
      kind: "pty",
      render: () => null,
      presentation: () => ({
        title: "test",
        icon: null,
        closeLabelKey: "close",
      }),
      labels,
      projectContextOf: () => null,
      lifecycle: {
        prepareHandoff: async ({ transferId }) => ({
          transferId,
          payload: { handoff: { token: transferId, sequence: 1 } },
        }),
        attachHandoff: async () => undefined,
        rollbackHandoff: async () => undefined,
      },
    });
    expect(getWorkspaceContentAdapter("pty").id).toBe("test.complete-handoff");
    dispose();
  });
});

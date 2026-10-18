import { describe, expect, it, vi } from "vitest";
import { isValidElement } from "react";
import {
  getWorkspaceContentAdapter,
  listWorkspaceContentAdapters,
  presentWorkspaceContent,
  registerWorkspaceContentAdapter,
  subscribeWorkspaceContentAdapters,
  workspaceContentProjectContext,
} from "./workspaceContentAdapterRegistry";
import { registerBuiltinWorkspaceContentAdapters } from "./workspaceContentAdapters/builtins";
import contentKinds from "../../contracts/content-kinds.json";
import { WORKSPACE_CONTENT_ADAPTER_API_VERSION } from "../lib/extensionApiVersions";

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
  it("provides safe presentation and project-context fallbacks without an adapter", () => {
    const context = {
      directories: [],
      ptySlots: [],
      ptySessionsById: {},
      fileDocuments: [],
      fileBuffers: {},
      selectedDirectoryId: null,
    };

    expect(
      presentWorkspaceContent({ kind: "file", documentId: "file-1" }, context),
    ).toMatchObject({
      title: "file",
      icon: null,
      tooltip: "file",
      closeLabelKey: "workspaceContent.closeUnsupported",
    });
    expect(
      workspaceContentProjectContext(
        { kind: "file", documentId: "file-1" },
        context,
      ),
    ).toBeNull();
  });

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
      apiVersion: 3 as const,
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
      apiVersion: 3,
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
        apiVersion: 3,
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
        apiVersion: 3,
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
      } as unknown as Parameters<typeof registerWorkspaceContentAdapter>[0]),
    ).toThrow("不支持内容适配器 API 版本: 1");
  });

  it("notifies subscribers when registrations are added and removed", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeWorkspaceContentAdapters(listener);
    const dispose = registerWorkspaceContentAdapter({
      id: "test.notify",
      apiVersion: 3,
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
        apiVersion: 3,
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
      apiVersion: 3,
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

describe("content adapter contract version 3", () => {
  const presentationContext = {
    directories: [],
    ptySlots: [],
    ptySessionsById: {},
    fileDocuments: [],
    fileBuffers: {},
    selectedDirectoryId: null,
  } as never;

  it("rejects an adapter that declares the previous API version", () => {
    expect(() =>
      registerWorkspaceContentAdapter({
        id: "test.v2",
        apiVersion: 2 as never,
        kind: "file",
        render: () => null,
        presentation: () => ({
          title: "t",
          icon: null,
          closeLabelKey: "close",
        }),
        labels,
        projectContextOf: () => null,
      } as never),
    ).toThrow("不支持内容适配器 API 版本: 2");
    // 反向：被拒绝的注册没有残留。
    expect(() => getWorkspaceContentAdapter("file")).toThrow(
      "未注册内容适配器: file",
    );
  });

  it("rejects an adapter whose content kind is not registered in the contract", () => {
    expect(() =>
      registerWorkspaceContentAdapter({
        id: "test.unregistered",
        apiVersion: WORKSPACE_CONTENT_ADAPTER_API_VERSION as never,
        kind: "markdownPreview" as never,
        render: () => null,
        presentation: () => ({
          title: "t",
          icon: null,
          closeLabelKey: "close",
        }),
        labels,
        projectContextOf: () => null,
      } as never),
    ).toThrow("内容类型未在契约登记: markdownPreview");
  });

  it("accepts exactly the version declared in the content-kinds contract", () => {
    expect(contentKinds.adapterApiVersion).toBe(3);
    const dispose = registerWorkspaceContentAdapter({
      id: "test.contract",
      apiVersion: contentKinds.adapterApiVersion as never,
      kind: "file",
      render: () => null,
      presentation: () => ({
        title: "t",
        icon: null,
        closeLabelKey: "close",
      }),
      labels,
      projectContextOf: () => null,
    } as never);
    expect(typeof dispose).toBe("function");
    dispose();
    expect(() => getWorkspaceContentAdapter("file")).toThrow(
      "未注册内容适配器: file",
    );
    // 反向：版本号差 1 的 adapter 被拒绝。
    expect(() =>
      registerWorkspaceContentAdapter({
        id: "test.contract-plus-one",
        apiVersion: (contentKinds.adapterApiVersion + 1) as never,
        kind: "file",
        render: () => null,
        presentation: () => ({
          title: "t",
          icon: null,
          closeLabelKey: "close",
        }),
        labels,
        projectContextOf: () => null,
      } as never),
    ).toThrow("不支持内容适配器 API 版本");
  });

  it("presents and resolves project context through any registered kind without kind branches", () => {
    const dispose = registerWorkspaceContentAdapter({
      id: "test.file-presentation",
      apiVersion: 3,
      kind: "file",
      render: () => null,
      presentation: (content: { documentId: string }) => ({
        title: "T-" + content.documentId,
        icon: null,
        closeLabelKey: "close",
      }),
      labels,
      projectContextOf: () => 7,
    } as never);
    expect(
      presentWorkspaceContent(
        { kind: "file", documentId: "x" } as never,
        presentationContext,
      ).title,
    ).toBe("T-x");
    expect(
      workspaceContentProjectContext(
        { kind: "file", documentId: "x" } as never,
        presentationContext,
      ),
    ).toBe(7);
    // 反向：未知内容保留原始类型名，没有项目上下文。
    const unknown = {
      kind: "unknown",
      originalKind: "markdownPreview",
      raw: {},
    } as never;
    expect(presentWorkspaceContent(unknown, presentationContext)).toMatchObject(
      {
        title: "markdownPreview",
        closeLabelKey: "workspaceContent.closeUnsupported",
      },
    );
    expect(
      workspaceContentProjectContext(unknown, presentationContext),
    ).toBeNull();
    dispose();
  });

  it("lists registered adapters in registration order and drops unregistered ones", () => {
    const make = (id: string, kind: "pty" | "file") =>
      ({
        id,
        apiVersion: WORKSPACE_CONTENT_ADAPTER_API_VERSION,
        kind,
        render: () => null,
        presentation: () => ({
          title: "t",
          icon: null,
          closeLabelKey: "close",
        }),
        labels,
        projectContextOf: () => null,
      }) as never;
    const unregisterPty = registerWorkspaceContentAdapter(
      make("test.list-pty", "pty"),
    );
    let unregisterFile: (() => void) | undefined;
    try {
      unregisterFile = registerWorkspaceContentAdapter(
        make("test.list-file", "file"),
      );
      expect(
        listWorkspaceContentAdapters().map((adapter) => adapter.id),
      ).toEqual(["test.list-pty", "test.list-file"]);

      unregisterPty();
      expect(
        listWorkspaceContentAdapters().map((adapter) => adapter.id),
      ).toEqual(["test.list-file"]);
    } finally {
      unregisterPty();
      unregisterFile?.();
    }
    // Reverse: nothing is left registered.
    expect(listWorkspaceContentAdapters()).toEqual([]);
  });
});

// @vitest-environment jsdom
import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "react-i18next",
  async () => (await import("../test/host/hostMocks")).reactI18nextMock,
);
vi.mock(
  "sonner",
  async () => (await import("../test/host/hostMocks")).sonnerMock,
);
vi.mock(
  "./PtyTerminal",
  async () => (await import("../test/host/hostMocks")).ptyTerminalMock,
);

import { tauriMock } from "../test/tauriMock";
import { resetFakeTerminals } from "../test/host/hostMocks";
import { assertWorkspaceInvariants } from "../test/host/workspaceInvariants";
import {
  DIRECTORY,
  detachFileToWindow,
  detachPtyToWindow,
  flush,
  launchPty,
  mountWorkspace,
  openFile,
  type WorkspaceHost,
} from "../test/host/workspaceHarness";
import { listWorkspacePanes } from "../lib/ptyWorkspaceLayout";
import { WorkspaceContentCoordinator } from "../lib/workspaceContentCoordinator";
import { WORKSPACE_LAYOUT_SCHEMA_VERSION } from "../lib/workspaceLayoutPersistence";
import type { WorkspaceLayoutDocument } from "../lib/tauri";

let host: WorkspaceHost | undefined;
afterEach(async () => {
  host?.dispose();
  host = undefined;
  cleanup();
  resetFakeTerminals();
  vi.useRealTimers();
  await flush();
  expect(tauriMock.state.eventListeners).toHaveLength(0);
  // ACL 拒绝会被宿主吞掉时用例仍可能通过，所以显式断言没有任何权限违规。
  expect(tauriMock.state.aclViolations).toEqual([]);
});

describe("content registration in the coordinator", () => {
  it("registers a launched PTY in the coordinator as attached to the target pane", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    const { slot } = await launchPty(host);
    const paneId = listWorkspacePanes(host.ctx().tree)[0].id;

    expect(
      coordinator.get({ kind: "pty", slotId: slot.instanceId }),
    ).toMatchObject({
      phase: "attached",
      owner: { kind: "pane", windowLabel: "main", paneId },
    });
    expect(() => assertWorkspaceInvariants(host!)).not.toThrow();
    // 反向断言：新建终端不应被当作窗口拥有。
    expect(coordinator.listWindowOwned()).toEqual([]);
    expect(host.errors).toEqual([]);
  });

  it("registers an opened file as attached and keeps registration stable when the same file is opened again", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    const doc = await openFile(host);
    const paneId = listWorkspacePanes(host.ctx().tree)[0].id;
    const content = { kind: "file", documentId: doc.id } as const;
    const first = coordinator.get(content);

    expect(first).toMatchObject({
      phase: "attached",
      owner: { kind: "pane", windowLabel: "main", paneId },
    });

    await openFile(host);

    // 同一对象：证明对已登记且 owner 相同的内容重复登记是无操作。
    expect(coordinator.get(content)).toBe(first);
    const occurrences = listWorkspacePanes(host.ctx().tree)
      .flatMap((pane) => pane.contents)
      .filter(
        (candidate) =>
          candidate.kind === "file" && candidate.documentId === doc.id,
      );
    expect(occurrences).toHaveLength(1);
    expect(() => assertWorkspaceInvariants(host!)).not.toThrow();
    expect(host.errors).toEqual([]);
  });

  it("registers every content of an applied layout preset as attached to its pane", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    const presetLayout: WorkspaceLayoutDocument = {
      schemaVersion: WORKSPACE_LAYOUT_SCHEMA_VERSION,
      focusedPaneId: "pa",
      slots: [],
      detachedContents: [],
      documents: [
        {
          id: "preset-doc",
          directoryId: DIRECTORY.id,
          directoryPath: DIRECTORY.path,
          relativePath: "a.txt",
        },
      ],
      tree: {
        kind: "split",
        id: "s1",
        direction: "horizontal",
        ratio: 0.5,
        first: {
          kind: "pane",
          id: "pa",
          paneNumber: 1,
          contents: [{ kind: "file", documentId: "preset-doc" }],
          activeContent: { kind: "file", documentId: "preset-doc" },
        },
        second: {
          kind: "pane",
          id: "pb",
          paneNumber: 2,
          contents: [],
          activeContent: null,
        },
      },
    };
    host.backend.handlers.set("plan_apply_workspace_layout_preset", () => ({
      slotStates: [],
      layout: presetLayout,
    }));

    await act(async () => {
      await host!.ctx().applyWorkspaceLayoutPreset("preset-1");
    });
    await flush();

    expect(
      coordinator.get({ kind: "file", documentId: "preset-doc" }),
    ).toMatchObject({
      phase: "attached",
      owner: { kind: "pane", windowLabel: "main", paneId: "pa" },
    });
    expect(listWorkspacePanes(host.ctx().tree).map((pane) => pane.id)).toEqual([
      "pa",
      "pb",
    ]);
    expect(() => assertWorkspaceInvariants(host!)).not.toThrow();
    // 反向断言：应用预设不会让任何内容变成窗口拥有。
    expect(coordinator.listWindowOwned()).toEqual([]);
    expect(host.errors).toEqual([]);
  });
});

describe("window handle tables are not ownership facts", () => {
  it("keeps the window handle table out of ownership decisions for detached files and PTYs", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    const doc = await openFile(host);
    const { windowLabel } = await detachFileToWindow(host, doc.id);
    const { slot } = await launchPty(host);
    await detachPtyToWindow(host, slot.instanceId);

    const fileContent = { kind: "file", documentId: doc.id } as const;
    const ptyContent = { kind: "pty", slotId: slot.instanceId } as const;
    expect(coordinator.get(fileContent)).toMatchObject({
      phase: "detached",
      owner: { kind: "window", windowLabel },
    });
    expect(coordinator.listWindowOwned()).toEqual(
      expect.arrayContaining([fileContent, ptyContent]),
    );
    expect(host.ctx().detachedFileIds.has(doc.id)).toBe(true);
    expect(host.ctx().detachedInstanceIds.has(slot.instanceId)).toBe(true);
    expect(() => assertWorkspaceInvariants(host!)).not.toThrow();

    // 反向断言：对已由窗口拥有的文件再次分离必须是无操作，不创建新窗口。
    const createdBefore = tauriMock.state.createdWindows.length;
    await act(async () => {
      await host!.ctx().detachFile(doc.id);
    });
    await flush();
    expect(tauriMock.state.createdWindows).toHaveLength(createdBefore);
    // 反向断言：已由窗口拥有的 PTY 再次分离同样被拒绝（判据来自 coordinator），也不创建窗口。
    await expect(host.ctx().detachSession(slot.instanceId)).rejects.toThrow(
      "pty.detachedMoveUnavailable",
    );
    expect(tauriMock.state.createdWindows).toHaveLength(createdBefore);
    expect(host.errors).toEqual([]);
  });
});

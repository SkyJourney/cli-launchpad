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
  flush,
  invokes,
  launchPty,
  mountWorkspace,
  openFile,
  type WorkspaceHost,
} from "../test/host/workspaceHarness";
import { listWorkspacePanes } from "../lib/ptyWorkspaceLayout";
import { WorkspaceContentCoordinator } from "../lib/workspaceContentCoordinator";

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

/**
 * 公共前置：挂载宿主、打开 a.txt（落在 paneA）、拆分出空的 paneB 并获得焦点。
 * revisionBefore 记录在拆分之前的树修订号。
 */
async function setup() {
  const coordinator = new WorkspaceContentCoordinator();
  const h = await mountWorkspace({ coordinator });
  host = h;
  const doc = await openFile(h);
  const paneA = listWorkspacePanes(h.ctx().tree)[0];
  const revisionBefore = h.ctx().workspaceTreeRevision;
  await act(async () => {
    h.ctx().splitPane(paneA.id, "horizontal");
  });
  await flush();
  const panes = () => listWorkspacePanes(h.ctx().tree);
  const paneB = panes().find((p) => p.id !== paneA.id)!;
  return { h, coordinator, doc, paneA, paneB, panes, revisionBefore };
}

describe("workspace commands", () => {
  it("splitPane creates a focused pane next to the source", async () => {
    const { h, doc, paneA, panes, revisionBefore } = await setup();

    expect(panes()).toHaveLength(2);
    expect(h.ctx().focusedPaneId).toBe(
      panes().find((p) => p.id !== paneA.id)!.id,
    );
    expect(panes().find((p) => p.id !== paneA.id)!.contents).toEqual([]);
    expect(panes().find((p) => p.id === paneA.id)!.contents).toContainEqual({
      kind: "file",
      documentId: doc.id,
    });
    expect(h.ctx().workspaceTreeRevision).toBe(revisionBefore);
    expect(() => assertWorkspaceInvariants(h)).not.toThrow();
    expect(h.errors).toEqual([]);
  });

  it("activateFile activates the file in its pane and focuses that pane", async () => {
    const { h, doc, paneA, paneB, panes } = await setup();

    await act(async () => {
      h.ctx().focusPane(paneB.id);
    });
    act(() => {
      h.ctx().activateFile(paneA.id, doc.id);
    });
    await flush();

    expect(h.ctx().focusedPaneId).toBe(paneA.id);
    expect(panes().find((p) => p.id === paneA.id)!.activeContent).toEqual({
      kind: "file",
      documentId: doc.id,
    });
    expect(panes().find((p) => p.id === paneB.id)!.activeContent).toBeNull();
    expect(() => assertWorkspaceInvariants(h)).not.toThrow();
    expect(h.errors).toEqual([]);
  });

  it("splitAndMoveFile moves the file into a new focused pane", async () => {
    const { h, coordinator, doc, paneA, panes } = await setup();

    act(() => {
      h.ctx().splitAndMoveFile(paneA.id, doc.id, "vertical");
    });
    await flush();

    expect(panes()).toHaveLength(3);
    const holder = panes().find((p) =>
      p.contents.some((c) => c.kind === "file" && c.documentId === doc.id),
    )!;
    expect(holder.id).not.toBe(paneA.id);
    expect(h.ctx().focusedPaneId).toBe(holder.id);
    expect(coordinator.get({ kind: "file", documentId: doc.id })).toMatchObject(
      {
        phase: "attached",
        owner: { kind: "pane", windowLabel: "main", paneId: holder.id },
      },
    );
    expect(panes().find((p) => p.id === paneA.id)!.contents).not.toContainEqual(
      {
        kind: "file",
        documentId: doc.id,
      },
    );
    expect(() => assertWorkspaceInvariants(h)).not.toThrow();
    expect(h.errors).toEqual([]);
  });

  it("moveFile moves the file to the destination pane and focuses it", async () => {
    const { h, coordinator, doc, paneA, paneB, panes } = await setup();

    act(() => {
      h.ctx().moveFile(paneA.id, paneB.id, doc.id);
    });
    await flush();

    expect(panes().find((p) => p.id === paneB.id)!.contents).toContainEqual({
      kind: "file",
      documentId: doc.id,
    });
    expect(h.ctx().focusedPaneId).toBe(paneB.id);
    expect(coordinator.get({ kind: "file", documentId: doc.id })).toMatchObject(
      {
        owner: { paneId: paneB.id },
      },
    );
    expect(panes().find((p) => p.id === paneA.id)!.contents).not.toContainEqual(
      {
        kind: "file",
        documentId: doc.id,
      },
    );
    expect(() => assertWorkspaceInvariants(h)).not.toThrow();
    expect(h.errors).toEqual([]);
  });

  it("moveFile to the same pane is ignored", async () => {
    const { h, doc, paneA } = await setup();
    const before = h.ctx().tree;
    const focusBefore = h.ctx().focusedPaneId;

    act(() => {
      h.ctx().moveFile(paneA.id, paneA.id, doc.id);
    });
    await flush();

    expect(h.ctx().tree).toBe(before);
    expect(h.ctx().focusedPaneId).toBe(focusBefore);
    expect(() => assertWorkspaceInvariants(h)).not.toThrow();
    expect(h.errors).toEqual([]);
  });

  it("moveSession moves a launched PTY between panes", async () => {
    const { h, coordinator, paneA, paneB, panes } = await setup();
    const { slot } = await launchPty(h);

    act(() => {
      h.ctx().moveSession(paneB.id, paneA.id, slot.instanceId);
    });
    await flush();

    expect(panes().find((p) => p.id === paneA.id)!.contents).toContainEqual({
      kind: "pty",
      slotId: slot.instanceId,
    });
    expect(h.ctx().focusedPaneId).toBe(paneA.id);
    expect(
      coordinator.get({ kind: "pty", slotId: slot.instanceId }),
    ).toMatchObject({
      owner: { paneId: paneA.id },
    });
    expect(panes().find((p) => p.id === paneB.id)!.contents).not.toContainEqual(
      {
        kind: "pty",
        slotId: slot.instanceId,
      },
    );
    expect(() => assertWorkspaceInvariants(h)).not.toThrow();
    expect(h.errors).toEqual([]);
  });

  it("closeEmptyPane removes an empty focused pane and falls back to the first pane", async () => {
    const { h, paneA, paneB, panes } = await setup();
    const revisionBefore = h.ctx().workspaceTreeRevision;

    act(() => {
      h.ctx().closeEmptyPane(paneB.id);
    });
    await flush();

    expect(panes().map((p) => p.id)).toEqual([paneA.id]);
    expect(h.ctx().focusedPaneId).toBe(paneA.id);
    expect(h.ctx().workspaceTreeRevision).toBe(revisionBefore + 1);

    // 反向：非空 pane 不会被关闭，树对象与修订号都不变。
    const treeBeforeNonEmpty = h.ctx().tree;
    const revisionBeforeNonEmpty = h.ctx().workspaceTreeRevision;
    act(() => {
      h.ctx().closeEmptyPane(paneA.id);
    });
    await flush();

    expect(panes()).toHaveLength(1);
    expect(h.ctx().tree).toBe(treeBeforeNonEmpty);
    expect(h.ctx().workspaceTreeRevision).toBe(revisionBeforeNonEmpty);
    expect(() => assertWorkspaceInvariants(h)).not.toThrow();
    expect(h.errors).toEqual([]);
  });

  it("opening an already open file activates it in the pane that owns it", async () => {
    const { h, doc, paneA, paneB, panes } = await setup();

    act(() => {
      h.ctx().moveFile(paneA.id, paneB.id, doc.id);
    });
    await flush();
    await act(async () => {
      h.ctx().focusPane(paneA.id);
    });
    await openFile(h);

    expect(h.ctx().fileDocuments).toHaveLength(1);
    expect(h.ctx().focusedPaneId).toBe(paneB.id);
    expect(panes().find((p) => p.id === paneB.id)!.activeContent).toEqual({
      kind: "file",
      documentId: doc.id,
    });
    expect(invokes("open_project_file")).toHaveLength(1);
    expect(() => assertWorkspaceInvariants(h)).not.toThrow();
    expect(h.errors).toEqual([]);
  });

  it("launchPty places the new session in the focused pane and registers it", async () => {
    const { h, coordinator, paneA, panes } = await setup();

    await act(async () => {
      h.ctx().focusPane(paneA.id);
    });
    const { slot } = await launchPty(h);

    expect(panes().find((p) => p.id === paneA.id)!.contents).toContainEqual({
      kind: "pty",
      slotId: slot.instanceId,
    });
    expect(h.ctx().focusedPaneId).toBe(paneA.id);
    expect(
      coordinator.get({ kind: "pty", slotId: slot.instanceId }),
    ).toMatchObject({
      phase: "attached",
      owner: { kind: "pane", windowLabel: "main", paneId: paneA.id },
    });
    expect(h.ctx().slots).toHaveLength(1);
    expect(() => assertWorkspaceInvariants(h)).not.toThrow();
    expect(h.errors).toEqual([]);
  });
});

// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
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
import {
  encodeWorkspaceContentDrag,
  WORKSPACE_CONTENT_DRAG_TYPE,
} from "../lib/workspaceContentDrag";

let host: WorkspaceHost | undefined;

afterEach(async () => {
  host?.dispose();
  host = undefined;
  cleanup();
  resetFakeTerminals();
  vi.useRealTimers();
  await flush();
  expect(tauriMock.state.eventListeners).toHaveLength(0);
  expect(tauriMock.state.aclViolations).toEqual([]);
});

function makeDataTransfer() {
  const store = new Map<string, string>();
  return {
    effectAllowed: "",
    dropEffect: "",
    get types() {
      return [...store.keys()];
    },
    setData(type: string, value: string) {
      store.set(type, value);
    },
    getData(type: string) {
      return store.get(type) ?? "";
    },
  };
}

function paneElement(paneNumber: number) {
  return screen.getByRole("region", {
    name: `pty.paneNumber:${JSON.stringify({ number: paneNumber })}`,
  });
}

function tabElement(key: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    `[data-workspace-content-key="${key}"]`,
  );
  if (!element) throw new Error(`tab ${key} is not rendered`);
  if (element.getAttribute("draggable") === "true") return element;
  const draggable = element.querySelector<HTMLElement>('[draggable="true"]');
  if (!draggable) throw new Error(`tab ${key} is not draggable`);
  return draggable;
}

describe("pane drag and drop", () => {
  async function setup() {
    host = await mountWorkspace({
      coordinator: new WorkspaceContentCoordinator(),
    });
    const doc = await openFile(host);
    const [onlyPane] = listWorkspacePanes(host.ctx().tree);
    act(() => {
      host!.ctx().splitPane(onlyPane.id, "horizontal");
    });
    await flush();
    const panes = () => listWorkspacePanes(host!.ctx().tree);
    const paneA = panes().find((p) => p.id === onlyPane.id)!;
    const paneB = panes().find((p) => p.id !== onlyPane.id)!;
    return { doc, paneA, paneB, panes };
  }

  it("dragging a file tab onto another pane moves the file", async () => {
    const { doc, paneA, paneB, panes } = await setup();
    const coordinator = host!.coordinator!;
    const dataTransfer = makeDataTransfer();

    await act(async () => {
      fireEvent.dragStart(tabElement(`file:${doc.id}`), { dataTransfer });
      fireEvent.dragOver(paneElement(paneB.paneNumber), { dataTransfer });
      fireEvent.drop(paneElement(paneB.paneNumber), { dataTransfer });
    });
    await flush();

    expect(dataTransfer.types).toContain(
      "application/x-cli-launchpad-workspace-content",
    );
    expect(panes().find((p) => p.id === paneB.id)!.contents).toContainEqual({
      kind: "file",
      documentId: doc.id,
    });
    expect(host!.ctx().focusedPaneId).toBe(paneB.id);
    expect(coordinator.get({ kind: "file", documentId: doc.id })).toMatchObject(
      {
        phase: "attached",
        owner: { kind: "pane", windowLabel: "main", paneId: paneB.id },
      },
    );
    expect(() => assertWorkspaceInvariants(host!)).not.toThrow();
    // 反向：源 pane 不再含该文件，且没有宿主错误。
    expect(panes().find((p) => p.id === paneA.id)!.contents).not.toContainEqual(
      {
        kind: "file",
        documentId: doc.id,
      },
    );
    expect(host!.errors).toEqual([]);
  });

  it("dragging a PTY tab onto another pane moves the session", async () => {
    const { paneA, paneB, panes } = await setup();
    const { slot } = await launchPty(host!);
    act(() => {
      host!.ctx().moveSession(paneB.id, paneA.id, slot.instanceId);
    });
    await flush();
    const dataTransfer = makeDataTransfer();

    await act(async () => {
      fireEvent.dragStart(tabElement(`pty:${slot.instanceId}`), {
        dataTransfer,
      });
      fireEvent.drop(paneElement(paneB.paneNumber), { dataTransfer });
    });
    await flush();

    expect(panes().find((p) => p.id === paneB.id)!.contents).toContainEqual({
      kind: "pty",
      slotId: slot.instanceId,
    });
    expect(host!.ctx().focusedPaneId).toBe(paneB.id);
    // 反向：源 pane 不再含该 PTY，且没有宿主错误。
    expect(panes().find((p) => p.id === paneA.id)!.contents).not.toContainEqual(
      {
        kind: "pty",
        slotId: slot.instanceId,
      },
    );
    expect(host!.errors).toEqual([]);
  });
});

describe("detached content return drops", () => {
  const OTHER_WINDOW = "workspace-content-00000000-0000-4000-8000-000000000000";

  function returnDropEvents(type: string, target: string) {
    return tauriMock.state.emittedEvents.filter(
      (event) =>
        event.target === target &&
        (event.payload as { type?: string }).type === type,
    );
  }

  it("returning a detached PTY onto a pane emits a return-drop to its window only", async () => {
    host = await mountWorkspace({
      coordinator: new WorkspaceContentCoordinator(),
    });
    const [onlyPane] = listWorkspacePanes(host.ctx().tree);
    act(() => {
      host!.ctx().splitPane(onlyPane.id, "horizontal");
    });
    await flush();
    const paneB = listWorkspacePanes(host.ctx().tree).find(
      (p) => p.id !== onlyPane.id,
    )!;
    const { slot } = await launchPty(host);
    const { windowLabel } = await detachPtyToWindow(host, slot.instanceId);

    const dataTransfer = makeDataTransfer();
    dataTransfer.setData(
      WORKSPACE_CONTENT_DRAG_TYPE,
      encodeWorkspaceContentDrag({
        key: `pty:${slot.instanceId}`,
        sourceWindowLabel: windowLabel,
      }),
    );
    await act(async () => {
      fireEvent.drop(paneElement(paneB.paneNumber), { dataTransfer });
    });
    await flush();

    expect(
      returnDropEvents("pty-return-drop-requested", windowLabel),
    ).toHaveLength(1);
    expect(
      returnDropEvents("pty-return-drop-requested", windowLabel)[0].payload,
    ).toMatchObject({
      payload: { instanceId: slot.instanceId, targetPaneId: paneB.id },
    });

    // 反向：来自未分离窗口的同类载荷不发出回传事件。
    const foreign = makeDataTransfer();
    foreign.setData(
      WORKSPACE_CONTENT_DRAG_TYPE,
      encodeWorkspaceContentDrag({
        key: `pty:${slot.instanceId}`,
        sourceWindowLabel: OTHER_WINDOW,
      }),
    );
    await act(async () => {
      fireEvent.drop(paneElement(paneB.paneNumber), { dataTransfer: foreign });
    });
    await flush();
    expect(
      tauriMock.state.emittedEvents.filter(
        (e) =>
          (e.payload as { type?: string }).type === "pty-return-drop-requested",
      ),
    ).toHaveLength(1);
    expect(host.errors).toEqual([]);
  });

  it("returning a detached file onto a pane emits a return-drop to its window only", async () => {
    host = await mountWorkspace({
      coordinator: new WorkspaceContentCoordinator(),
    });
    const doc = await openFile(host);
    const [onlyPane] = listWorkspacePanes(host.ctx().tree);
    act(() => {
      host!.ctx().splitPane(onlyPane.id, "horizontal");
    });
    await flush();
    const paneB = listWorkspacePanes(host.ctx().tree).find(
      (p) => p.id !== onlyPane.id,
    )!;
    const { windowLabel } = await detachFileToWindow(host, doc.id);

    const dataTransfer = makeDataTransfer();
    dataTransfer.setData(
      WORKSPACE_CONTENT_DRAG_TYPE,
      encodeWorkspaceContentDrag({
        key: `file:${doc.id}`,
        sourceWindowLabel: windowLabel,
      }),
    );
    await act(async () => {
      fireEvent.drop(paneElement(paneB.paneNumber), { dataTransfer });
    });
    await flush();

    const events = returnDropEvents(
      "workspace-file-window-return-drop-requested",
      windowLabel,
    );
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      payload: { documentId: doc.id, targetPaneId: paneB.id },
    });

    // 反向：未分离窗口的文件载荷不发出回传事件。
    const foreign = makeDataTransfer();
    foreign.setData(
      WORKSPACE_CONTENT_DRAG_TYPE,
      encodeWorkspaceContentDrag({
        key: `file:${doc.id}`,
        sourceWindowLabel: OTHER_WINDOW,
      }),
    );
    await act(async () => {
      fireEvent.drop(paneElement(paneB.paneNumber), { dataTransfer: foreign });
    });
    await flush();
    expect(
      tauriMock.state.emittedEvents.filter(
        (e) =>
          (e.payload as { type?: string }).type ===
          "workspace-file-window-return-drop-requested",
      ),
    ).toHaveLength(1);
    expect(host.errors).toEqual([]);
  });

  it("rejects a payload in the previous format and changes nothing", async () => {
    host = await mountWorkspace({
      coordinator: new WorkspaceContentCoordinator(),
    });
    const doc = await openFile(host);
    const [onlyPane] = listWorkspacePanes(host.ctx().tree);
    act(() => {
      host!.ctx().splitPane(onlyPane.id, "horizontal");
    });
    await flush();
    const paneB = listWorkspacePanes(host.ctx().tree).find(
      (p) => p.id !== onlyPane.id,
    )!;
    const before = host.ctx().tree;
    const dataTransfer = makeDataTransfer();
    dataTransfer.setData(
      WORKSPACE_CONTENT_DRAG_TYPE,
      'cli-launchpad-content-v1:{"kind":"file","contentId":"' +
        doc.id +
        '","sourcePaneId":"' +
        onlyPane.id +
        '","sourceWindowLabel":"main"}',
    );
    await act(async () => {
      fireEvent.drop(paneElement(paneB.paneNumber), { dataTransfer });
    });
    await flush();

    expect(host.ctx().tree).toBe(before);
    expect(
      listWorkspacePanes(host.ctx().tree).find((p) => p.id === paneB.id)!
        .contents,
    ).toEqual([]);
    expect(host.errors).toEqual([]);
  });
});

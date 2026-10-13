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
  flush,
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

// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
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

import { WorkspaceContentCoordinator } from "../lib/workspaceContentCoordinator";
import { tauriMock } from "../test/tauriMock";
import { resetFakeTerminals, toastSpy } from "../test/host/hostMocks";
import { assertWorkspaceInvariants } from "../test/host/workspaceInvariants";
import {
  deferred,
  emitToMain,
  flush,
  invokes,
  mountWorkspace,
  openFile,
  type WorkspaceHost,
  relayedHandoffs,
} from "../test/host/workspaceHarness";

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

describe("save outcomes", () => {
  async function mountWithDraft() {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    const doc = await openFile(host!);
    await act(async () => {
      host!.ctx().editFile(doc.id, "x");
    });
    return doc;
  }

  it("coalesces concurrent save requests into one backend write", async () => {
    const doc = await mountWithDraft();
    host!.backend.handlers.set("save_project_text_file", () => ({
      kind: "saved",
      content: "x",
      revision: "r2",
      warning: null,
    }));

    await act(async () => {
      await Promise.all([
        host!.ctx().saveFile(doc.id),
        host!.ctx().saveFile(doc.id),
      ]);
    });
    await flush();

    expect(invokes("save_project_text_file")).toHaveLength(1);
    expect(host!.ctx().fileBuffers[doc.id]).toMatchObject({
      saving: false,
      savedContent: "x",
      revision: "r2",
    });
    expect(toastSpy.error).not.toHaveBeenCalled();
    assertWorkspaceInvariants(host!);
    expect(host!.errors).toEqual([]);
  });

  it("marks a conflict, keeps the draft and offers reload", async () => {
    const doc = await mountWithDraft();
    host!.backend.handlers.set("save_project_text_file", () => ({
      kind: "conflict",
    }));

    await act(async () => {
      await host!.ctx().saveFile(doc.id);
    });
    await flush();

    expect(host!.ctx().fileBuffers[doc.id]?.conflict).toBe(true);
    expect(host!.ctx().fileBuffers[doc.id]?.content).toBe("x");
    expect(
      toastSpy.error.mock.calls.some((call) =>
        (
          call[1] as { action?: { label: string } } | undefined
        )?.action?.label.includes("workspaceFiles.reload"),
      ),
    ).toBe(true);
    expect(host!.ctx().fileBuffers[doc.id]?.saving).toBe(false);
    assertWorkspaceInvariants(host!);
    expect(host!.errors).toEqual([]);
  });

  it("marks a project identity change and blocks further saves", async () => {
    const doc = await mountWithDraft();
    host!.backend.handlers.set("save_project_text_file", () => {
      throw { code: "project_identity_changed", message: "x" };
    });

    await act(async () => {
      await host!.ctx().saveFile(doc.id);
    });
    await flush();
    expect(host!.ctx().fileBuffers[doc.id]?.identityChanged).toBe(true);

    const before = invokes("save_project_text_file").length;
    await act(async () => {
      await host!.ctx().saveFile(doc.id);
    });
    expect(invokes("save_project_text_file")).toHaveLength(before);
    expect(
      toastSpy.error.mock.calls.some((call) =>
        String(call[0]).includes("workspaceFiles.projectIdentityChanged"),
      ),
    ).toBe(true);
    assertWorkspaceInvariants(host!);
    expect(host!.errors).toEqual([]);
  });

  it("restores the draft after a generic failure", async () => {
    const doc = await mountWithDraft();
    host!.backend.handlers.set("save_project_text_file", () => {
      throw new Error("disk full");
    });

    await act(async () => {
      await host!.ctx().saveFile(doc.id);
    });
    await flush();

    expect(host!.ctx().fileBuffers[doc.id]?.saving).toBe(false);
    expect(host!.ctx().fileBuffers[doc.id]?.content).toBe("x");
    expect(
      toastSpy.error.mock.calls.some((call) =>
        String(call[0]).includes("disk full"),
      ),
    ).toBe(true);
    expect(host!.ctx().fileBuffers[doc.id]?.identityChanged).not.toBe(true);
    expect(host!.ctx().fileBuffers[doc.id]?.conflict).not.toBe(true);
    assertWorkspaceInvariants(host!);
    expect(host!.errors).toEqual([]);
  });
});

describe("in-flight saves", () => {
  async function mountWithPendingSave() {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    const doc = await openFile(host!);
    const save = deferred<unknown>();
    host!.backend.handlers.set("save_project_text_file", () => save.promise);
    await act(async () => {
      host!.ctx().editFile(doc.id, "edited");
    });
    const saving = host!.ctx().saveFile(doc.id);
    await flush();
    expect(host!.ctx().fileBuffers[doc.id]?.saving).toBe(true);
    return { doc, save, saving };
  }

  it("clears saving after a named layout applies during the save", async () => {
    const { doc, save, saving } = await mountWithPendingSave();
    host!.backend.handlers.set("plan_apply_workspace_layout_preset", () => ({
      slotStates: [],
      layout: {
        schemaVersion: 5,
        focusedPaneId: "pa",
        slots: [],
        detachedContents: [],
        documents: [
          {
            id: "p-doc",
            directoryId: 1,
            directoryPath: "C:/project",
            relativePath: "a.txt",
          },
        ],
        tree: {
          kind: "pane",
          id: "pa",
          paneNumber: 1,
          contents: [{ kind: "file", documentId: "p-doc" }],
          activeContent: { kind: "file", documentId: "p-doc" },
        },
      },
    }));

    await act(async () => {
      await host!.ctx().applyWorkspaceLayoutPreset("p");
    });
    save.resolve({
      kind: "saved",
      content: "edited",
      revision: "r2",
      warning: null,
    });
    await saving;
    await flush();

    expect(host!.ctx().fileBuffers[doc.id]).toMatchObject({
      saving: false,
      savedContent: "edited",
      revision: "r2",
    });
    expect(host!.ctx().fileDocuments.map((d) => d.id)).toEqual([doc.id]);
    assertWorkspaceInvariants(host!, { allowPendingSaves: false });
    expect(host!.errors).toEqual([]);
  });

  it("does not resurrect a document closed while its save is in flight", async () => {
    const { doc, save, saving } = await mountWithPendingSave();

    await act(async () => {
      void host!
        .ctx()
        .closeContents([{ kind: "file", documentId: doc.id }], "tab");
    });
    await flush();
    const dialog = screen.getByRole("alertdialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "common.confirm" }),
    );
    await flush();

    save.resolve({
      kind: "saved",
      content: "edited",
      revision: "r2",
      warning: null,
    });
    await saving;
    await flush();

    expect(host!.ctx().fileDocuments).toEqual([]);
    expect(host!.ctx().fileBuffers[doc.id]).toBeUndefined();
    expect(host!.editor.releaseDocument).toHaveBeenCalledTimes(1);
    expect(host!.editor.releaseDocument).toHaveBeenCalledWith(doc.id);
    expect(toastSpy.error).not.toHaveBeenCalled();
  });

  it("reloads only after the in-flight save settles", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    host = await mountWorkspace({ coordinator });
    const doc = await openFile(host!);
    await act(async () => {
      host!.ctx().editFile(doc.id, "x");
    });
    host!.backend.handlers.set("save_project_text_file", () => ({
      kind: "conflict",
    }));
    await act(async () => {
      await host!.ctx().saveFile(doc.id);
    });
    await flush();
    const reloadAction = toastSpy.error.mock.calls
      .map(
        (call) => call[1] as { action?: { onClick: () => void } } | undefined,
      )
      .filter((options) => options?.action)
      .slice(-1)[0]!.action!;
    const epochBefore = host!.ctx().fileBuffers[doc.id]?.epoch;

    await act(async () => {
      host!.ctx().editFile(doc.id, "second");
    });
    const second = deferred<unknown>();
    host!.backend.handlers.set("save_project_text_file", () => second.promise);
    const saving2 = host!.ctx().saveFile(doc.id);
    host!.backend.files.set("a.txt", { content: "disk-v2", revision: "r9" });

    await act(async () => {
      void reloadAction.onClick();
    });
    await flush();
    expect(invokes("open_project_file")).toHaveLength(1);

    second.resolve({
      kind: "saved",
      content: "second",
      revision: "r3",
      warning: null,
    });
    await saving2;
    await flush();

    expect(invokes("open_project_file")).toHaveLength(2);
    expect(host!.ctx().fileBuffers[doc.id]).toMatchObject({
      content: "disk-v2",
      savedContent: "disk-v2",
      saving: false,
    });
    expect(host!.ctx().fileBuffers[doc.id]?.epoch).toBe((epochBefore ?? 0) + 1);
    expect(host!.errors).toEqual([]);
  });

  it("starts a detach only after the in-flight save settles and transfers the saved buffer", async () => {
    const { doc, save, saving } = await mountWithPendingSave();

    await act(async () => {
      host!
        .ctx()
        .detachFile(doc.id)
        .catch(() => undefined);
    });
    await flush();
    expect(tauriMock.state.createdWindows).toHaveLength(0);
    expect(invokes("grant_content_window_file")).toHaveLength(0);

    save.resolve({
      kind: "saved",
      content: "edited",
      revision: "r2",
      warning: null,
    });
    await saving;
    await flush();

    const created =
      tauriMock.state.createdWindows[tauriMock.state.createdWindows.length - 1];
    expect(created).toBeDefined();
    const url = new URL(
      (created!.options as { url: string }).url,
      "http://localhost",
    );
    const token = url.searchParams.get("fileHandoffToken");
    expect(token).toBeTruthy();
    const windowLabel = created!.label;
    await act(async () => {
      await emitToMain("workspace-file-window-ready", {
        documentId: doc.id,
        token,
        windowLabel,
      });
    });
    await flush();

    const init = relayedHandoffs().find(
      (event) =>
        event.target === windowLabel &&
        event.legacyType === "workspace-file-window-init",
    );
    expect(init).toBeDefined();
    const fileBuffer = (
      init!.payload as { fileBuffer: Record<string, unknown> }
    ).fileBuffer;
    expect(fileBuffer).toMatchObject({
      saving: false,
      savedContent: "edited",
      content: "edited",
    });
    expect(host!.errors).toEqual([]);
  });
});

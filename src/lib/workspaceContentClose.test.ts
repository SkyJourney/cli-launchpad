import { describe, expect, it, vi } from "vitest";
import {
  canCloseWorkspaceContents,
  closeWorkspaceContentBatch,
  disposeWorkspaceContent,
  requestWorkspaceContentClose,
  shouldCloseWorkspaceContent,
  shouldCloseWorkspaceWindow,
  type WorkspaceContentBeforeCloseContext,
} from "./workspaceContentClose";
import { WorkspaceContentCoordinator } from "./workspaceContentCoordinator";

describe("workspace content close adapters", () => {
  it("allows a window close when no adapter hook is provided", () => {
    expect(shouldCloseWorkspaceWindow(undefined)).toBe(true);
  });

  it("lets an adapter allow or veto the shared native window close action", () => {
    expect(shouldCloseWorkspaceWindow(() => true)).toBe(true);
    expect(shouldCloseWorkspaceWindow(() => false)).toBe(false);
  });

  it("fails closed when a close hook throws", () => {
    expect(
      shouldCloseWorkspaceContent(
        () => {
          throw new Error("hook failed");
        },
        {
          isDirty: false,
          confirmDiscard: () => true,
        },
      ),
    ).toBe(false);
    expect(
      shouldCloseWorkspaceWindow(() => {
        throw new Error("hook failed");
      }),
    ).toBe(false);
  });

  it("continues closing by default when an adapter has no hook", () => {
    expect(
      shouldCloseWorkspaceContent(undefined, {
        isDirty: false,
        confirmDiscard: () => false,
      }),
    ).toBe(true);
  });

  it("lets an adapter veto the default close action", () => {
    expect(
      shouldCloseWorkspaceContent(() => false, {
        isDirty: false,
        confirmDiscard: () => true,
      }),
    ).toBe(false);
  });

  it("runs the adapter hook before a dirty file is closed", () => {
    const confirmDiscard = vi.fn(() => false);
    const fileBeforeClose = ({
      isDirty,
      confirmDiscard: confirm,
    }: {
      isDirty: boolean;
      confirmDiscard: () => boolean;
    }) => !isDirty || confirm();

    expect(
      shouldCloseWorkspaceContent(fileBeforeClose, {
        isDirty: true,
        confirmDiscard,
      }),
    ).toBe(false);
    expect(confirmDiscard).toHaveBeenCalledOnce();
  });

  it("does not ask to discard when the content is clean", () => {
    const confirmDiscard = vi.fn(() => false);
    const fileBeforeClose = ({
      isDirty,
      confirmDiscard: confirm,
    }: {
      isDirty: boolean;
      confirmDiscard: () => boolean;
    }) => !isDirty || confirm();

    expect(
      shouldCloseWorkspaceContent(fileBeforeClose, {
        isDirty: false,
        confirmDiscard,
      }),
    ).toBe(true);
    expect(confirmDiscard).not.toHaveBeenCalled();
  });

  it("runs the shared close action only after adapter approval", () => {
    const close = vi.fn();
    const hook = vi.fn(
      ({ isDirty, confirmDiscard }: WorkspaceContentBeforeCloseContext) =>
        !isDirty || confirmDiscard(),
    );
    const context = { isDirty: true, confirmDiscard: () => false };

    expect(requestWorkspaceContentClose(hook, context, close)).toBe(false);
    expect(close).not.toHaveBeenCalled();

    expect(
      requestWorkspaceContentClose(
        hook,
        { ...context, confirmDiscard: () => true },
        close,
      ),
    ).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });

  it("preflights a batch before allowing any contents to be removed", () => {
    const discard = vi.fn(() => true);
    const requests = [
      {
        hook: undefined,
        context: { isDirty: false, confirmDiscard: discard },
      },
      {
        hook: () => false,
        context: { isDirty: true, confirmDiscard: discard },
      },
      {
        hook: () => true,
        context: { isDirty: false, confirmDiscard: discard },
      },
    ];

    expect(canCloseWorkspaceContents(requests)).toBe(false);
    expect(discard).not.toHaveBeenCalled();
    expect(canCloseWorkspaceContents(requests.slice(0, 1))).toBe(true);
  });

  it("notifies the adapter exactly once after successful host disposal", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    const content = { kind: "file", documentId: "file-1" } as const;
    const owner = {
      kind: "pane",
      windowLabel: "main",
      paneId: "pane-1",
    } as const;
    coordinator.ensureAttached(content, owner);
    coordinator.approveClose(content, "close-1");
    const dispose = vi.fn();

    expect(
      await disposeWorkspaceContent({
        coordinator,
        content,
        reason: "closed",
        requestId: "close-1",
        dispose,
      }),
    ).toBe(true);
    expect(dispose).toHaveBeenCalledWith({
      content,
      owner,
      generation: 0,
      requestId: "close-1",
      reason: "closed",
    });
    expect(
      await disposeWorkspaceContent({
        coordinator,
        content,
        reason: "closed",
        requestId: "close-1",
        dispose,
      }),
    ).toBe(false);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("keeps a committed close disposed when adapter notification fails", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    const content = { kind: "pty", slotId: "slot-1" } as const;
    coordinator.ensureAttached(content, {
      kind: "pane",
      windowLabel: "main",
      paneId: "pane-1",
    });
    coordinator.approveClose(content, "close-1");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(
      await disposeWorkspaceContent({
        coordinator,
        content,
        reason: "closed",
        requestId: "close-1",
        dispose: () => {
          throw new Error("adapter failed");
        },
      }),
    ).toBe(true);
    expect(coordinator.get(content)).toBeUndefined();
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it("notifies adapter when the content owner ends naturally", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    const content = { kind: "pty", slotId: "slot-1" } as const;
    coordinator.ensureAttached(content, {
      kind: "pane",
      windowLabel: "main",
      paneId: "pane-1",
    });
    const dispose = vi.fn();

    expect(
      await disposeWorkspaceContent({
        coordinator,
        content,
        reason: "ownerEnded",
        dispose,
      }),
    ).toBe(true);
    expect(dispose).toHaveBeenCalledWith({
      content,
      owner: { kind: "pane", windowLabel: "main", paneId: "pane-1" },
      generation: 0,
      requestId: undefined,
      reason: "ownerEnded",
    });
  });

  it("disposes only committed members of a partial batch close", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    const pane = {
      kind: "pane",
      windowLabel: "main",
      paneId: "pane-1",
    } as const;
    const first = { kind: "pty", slotId: "slot-1" } as const;
    const second = { kind: "pty", slotId: "slot-2" } as const;
    coordinator.ensureAttached(first, pane);
    coordinator.ensureAttached(second, pane);
    const dispose = vi.fn();

    const closed = await closeWorkspaceContentBatch({
      coordinator,
      requestId: "batch-1",
      requests: [
        { content: first, beforeClose: () => true },
        { content: second, beforeClose: () => true },
      ],
      execute: () => [first],
      dispose,
    });

    expect(closed).toEqual([first]);
    expect(dispose).toHaveBeenCalledOnce();
    expect(coordinator.get(first)).toBeUndefined();
    expect(coordinator.get(second)?.phase).toBe("attached");
  });

  it("runs every preflight and cancels a mixed batch when any item vetoes", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    const pane = {
      kind: "pane",
      windowLabel: "main",
      paneId: "pane-1",
    } as const;
    const pty = { kind: "pty", slotId: "slot-1" } as const;
    const file = { kind: "file", documentId: "file-1" } as const;
    coordinator.ensureAttached(pty, pane);
    coordinator.ensureAttached(file, pane);
    const ptyPreflight = vi.fn(() => true);
    const filePreflight = vi.fn(() => false);
    const confirmImpacts = vi.fn(() => true);
    const execute = vi.fn(() => [pty, file]);

    const closed = await closeWorkspaceContentBatch({
      coordinator,
      requestId: "batch-vetoed",
      requests: [
        { content: pty, beforeClose: ptyPreflight },
        { content: file, beforeClose: filePreflight },
      ],
      confirmImpacts,
      execute,
      dispose: vi.fn(),
    });

    expect(closed).toEqual([]);
    expect(ptyPreflight).toHaveBeenCalledOnce();
    expect(filePreflight).toHaveBeenCalledOnce();
    expect(confirmImpacts).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(coordinator.get(pty)?.phase).toBe("attached");
    expect(coordinator.get(file)?.phase).toBe("attached");
  });

  it("asks once for combined PTY and file impacts and cancels both on rejection", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    const pane = {
      kind: "pane",
      windowLabel: "main",
      paneId: "pane-1",
    } as const;
    const pty = { kind: "pty", slotId: "slot-1" } as const;
    const file = { kind: "file", documentId: "file-1" } as const;
    coordinator.ensureAttached(pty, pane);
    coordinator.ensureAttached(file, pane);
    const confirmImpacts = vi.fn(() => false);
    const execute = vi.fn(() => [pty, file]);
    const dispose = vi.fn();

    const closed = await closeWorkspaceContentBatch({
      coordinator,
      requestId: "batch-cancelled",
      requests: [
        {
          content: pty,
          beforeClose: () => true,
          describeDisposalImpact: () => [
            { kind: "runningPty", title: "Terminal" },
          ],
        },
        {
          content: file,
          beforeClose: () => true,
          describeDisposalImpact: () => [
            { kind: "dirtyFile", title: "src/main.ts" },
          ],
        },
      ],
      confirmImpacts,
      execute,
      dispose,
    });

    expect(closed).toEqual([]);
    expect(confirmImpacts).toHaveBeenCalledOnce();
    expect(confirmImpacts).toHaveBeenCalledWith([
      { kind: "runningPty", title: "Terminal" },
      { kind: "dirtyFile", title: "src/main.ts" },
    ]);
    expect(execute).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    expect(coordinator.get(pty)?.phase).toBe("attached");
    expect(coordinator.get(file)?.phase).toBe("attached");
  });

  it("commits and disposes a mixed batch once after one approval", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    const pane = {
      kind: "pane",
      windowLabel: "main",
      paneId: "pane-1",
    } as const;
    const pty = { kind: "pty", slotId: "slot-1" } as const;
    const file = { kind: "file", documentId: "file-1" } as const;
    coordinator.ensureAttached(pty, pane);
    coordinator.ensureAttached(file, pane);
    const confirmImpacts = vi.fn(() => true);
    const onApproved = vi.fn();
    const execute = vi.fn(() => [pty, file]);
    const dispose = vi.fn();

    const closed = await closeWorkspaceContentBatch({
      coordinator,
      requestId: "batch-approved",
      requests: [
        {
          content: pty,
          beforeClose: () => true,
          describeDisposalImpact: () => [
            { kind: "runningPty", title: "Terminal" },
          ],
        },
        {
          content: file,
          beforeClose: () => true,
          describeDisposalImpact: () => [
            { kind: "dirtyFile", title: "src/main.ts" },
          ],
        },
      ],
      confirmImpacts,
      onApproved,
      execute,
      dispose,
    });

    expect(closed).toEqual([pty, file]);
    expect(confirmImpacts).toHaveBeenCalledOnce();
    expect(onApproved).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(coordinator.get(pty)).toBeUndefined();
    expect(coordinator.get(file)).toBeUndefined();
  });

  it("cancels all lifecycle approvals if the domain close operation fails", async () => {
    const coordinator = new WorkspaceContentCoordinator();
    const content = { kind: "file", documentId: "file-1" } as const;
    coordinator.ensureAttached(content, {
      kind: "pane",
      windowLabel: "main",
      paneId: "pane-1",
    });
    const dispose = vi.fn();

    await expect(
      closeWorkspaceContentBatch({
        coordinator,
        requestId: "batch-1",
        requests: [{ content, beforeClose: () => true }],
        execute: () => {
          throw new Error("domain close failed");
        },
        dispose,
      }),
    ).rejects.toThrow("domain close failed");
    expect(coordinator.get(content)?.phase).toBe("attached");
    expect(dispose).not.toHaveBeenCalled();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { registerWorkspaceContentAdapter } from "./workspaceContentAdapterRegistry";
import {
  attachWorkspaceContentHandoff,
  prepareWorkspaceContentHandoff,
  rollbackWorkspaceContentHandoff,
} from "./workspaceContentHandoffRuntime";

const labels = {
  menu: "menu",
  close: "close",
  closeCurrent: "closeCurrent",
  closeOthers: "closeOthers",
  closeAll: "closeAll",
  splitAndMoveRight: "splitRight",
  splitAndMoveDown: "splitDown",
};

describe("workspace content handoff runtime", () => {
  let unregister: (() => void) | undefined;
  const extraUnregisters: Array<() => void> = [];

  afterEach(() => {
    unregister?.();
    unregister = undefined;
    for (const dispose of extraUnregisters.splice(0)) dispose();
  });

  it("invokes adapter drivers with only the host-injected PTY capabilities", async () => {
    const prepare = vi.fn(async () => ({
      handoff: { token: "rust-token", sequence: 17 },
    }));
    const attach = vi.fn(async () => undefined);
    const rollback = vi.fn(async () => undefined);
    unregister = registerWorkspaceContentAdapter({
      id: "test.handoff-runtime",
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
        prepareHandoff: async ({ capabilities }) => {
          const payload = await capabilities.prepare();
          return { transferId: payload.handoff.token, payload };
        },
        attachHandoff: ({ capabilities }, payload) =>
          capabilities.attach(payload),
        rollbackHandoff: ({ capabilities }, payload, reason) =>
          capabilities.rollback(payload, reason),
      },
    });

    const context = {
      content: { kind: "pty", slotId: "slot-1" },
      source: { kind: "pane", windowLabel: "main", paneId: "pane-1" },
      target: { kind: "window", windowLabel: "terminal-1" },
      transferId: "frontend-request-id",
      capabilities: { prepare, attach, rollback },
    } as const;
    const prepared = await prepareWorkspaceContentHandoff(context);
    await attachWorkspaceContentHandoff(context, prepared.payload);
    const failure = new Error("attach failed");
    await rollbackWorkspaceContentHandoff(context, prepared.payload, failure);

    expect(prepared).toEqual({
      transferId: "rust-token",
      payload: { handoff: { token: "rust-token", sequence: 17 } },
    });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledWith(prepared.payload);
    expect(rollback).toHaveBeenCalledWith(prepared.payload, failure);
  });

  it("rejects a handoff when the adapter lacks a driver", async () => {
    const prepare = vi.fn(async () => ({ handoff: { token: "never" } }));
    const attach = vi.fn(async () => undefined);
    const rollback = vi.fn(async () => undefined);
    extraUnregisters.push(
      registerWorkspaceContentAdapter({
        id: "test.handoff-runtime.no-driver",
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
    );
    const context = {
      content: { kind: "pty", slotId: "slot-1" },
      source: { kind: "pane", windowLabel: "main", paneId: "pane-1" },
      target: { kind: "window", windowLabel: "terminal-1" },
      transferId: "frontend-request-id",
      capabilities: { prepare, attach, rollback },
    } as const;
    const payload = { handoff: { token: "t" } };

    // Callers await these inside async code, so a synchronous throw and a rejection both count.
    await expect(
      (async () => prepareWorkspaceContentHandoff(context))(),
    ).rejects.toThrow(/缺少 handoff driver/);
    await expect(
      (async () => attachWorkspaceContentHandoff(context, payload))(),
    ).rejects.toThrow(/缺少 handoff driver/);
    await expect(
      (async () =>
        rollbackWorkspaceContentHandoff(context, payload, new Error("x")))(),
    ).rejects.toThrow(/缺少 handoff driver/);

    expect(prepare).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
  });

  it("passes the attach failure to rollback with the prepared payload", async () => {
    const preparedPayload = { handoff: { token: "rust-token", sequence: 3 } };
    const attachFailure = new Error("attach rejected");
    const prepare = vi.fn(async () => preparedPayload);
    const attach = vi.fn(async () => {
      throw attachFailure;
    });
    const rollback = vi.fn(async (_payload: unknown, _reason: unknown) => {});
    extraUnregisters.push(
      registerWorkspaceContentAdapter({
        id: "test.handoff-runtime.rollback",
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
          prepareHandoff: async ({ capabilities }) => {
            const payload = await capabilities.prepare();
            return { transferId: payload.handoff.token, payload };
          },
          attachHandoff: ({ capabilities }, payload) =>
            capabilities.attach(payload),
          rollbackHandoff: ({ capabilities }, payload, reason) =>
            capabilities.rollback(payload, reason),
        },
      }),
    );
    const context = {
      content: { kind: "pty", slotId: "slot-1" },
      source: { kind: "pane", windowLabel: "main", paneId: "pane-1" },
      target: { kind: "window", windowLabel: "terminal-1" },
      transferId: "frontend-request-id",
      capabilities: { prepare, attach, rollback },
    } as const;

    const prepared = await prepareWorkspaceContentHandoff(context);
    let caught: unknown;
    try {
      await attachWorkspaceContentHandoff(context, prepared.payload);
    } catch (error) {
      caught = error;
    }
    // The runtime must not swallow or rewrap the attach failure: the caller rolls back with it.
    expect(caught).toBe(attachFailure);
    await rollbackWorkspaceContentHandoff(context, prepared.payload, caught);

    expect(rollback).toHaveBeenCalledTimes(1);
    expect(rollback.mock.calls[0]?.[0]).toBe(preparedPayload);
    expect(rollback.mock.calls[0]?.[1]).toBe(attachFailure);
  });

  it("routes file kind capabilities without touching PTY capabilities", async () => {
    const ptyDriver = {
      prepareHandoff: vi.fn(async () => ({
        transferId: "pty-transfer",
        payload: { handoff: { token: "pty-token" } },
      })),
      attachHandoff: vi.fn(async () => undefined),
      rollbackHandoff: vi.fn(async () => undefined),
    };
    const fileDocument = {
      id: "doc-1",
      directoryId: 7,
      directoryPath: "C:/work",
      relativePath: "a.txt",
    };
    const fileBuffer = {
      epoch: 1,
      version: 4,
      content: "hello",
      savedContent: "hello",
      revision: "r1",
      saving: false,
    };
    const filePrepare = vi.fn(async () => ({
      document: fileDocument,
      buffer: fileBuffer,
    }));
    const fileAttach = vi.fn(async () => undefined);
    const fileRollback = vi.fn(async () => undefined);
    const adapterBase = {
      apiVersion: 3 as const,
      render: () => null,
      presentation: () => ({
        title: "test",
        icon: null,
        closeLabelKey: "close",
      }),
      labels,
      projectContextOf: () => null,
    };
    extraUnregisters.push(
      registerWorkspaceContentAdapter({
        ...adapterBase,
        id: "test.handoff-runtime.routing-pty",
        kind: "pty",
        lifecycle: ptyDriver,
      }),
      registerWorkspaceContentAdapter({
        ...adapterBase,
        id: "test.handoff-runtime.routing-file",
        kind: "file",
        lifecycle: {
          prepareHandoff: async ({ capabilities, transferId }) => ({
            transferId,
            payload: await capabilities.prepare(),
          }),
          attachHandoff: ({ capabilities }, payload) =>
            capabilities.attach(payload),
          rollbackHandoff: ({ capabilities }, payload, reason) =>
            capabilities.rollback(payload, reason),
        },
      }),
    );
    const context = {
      content: { kind: "file", documentId: "doc-1" },
      source: { kind: "pane", windowLabel: "main", paneId: "pane-1" },
      target: { kind: "window", windowLabel: "workspace-content-1" },
      transferId: "file-transfer-1",
      capabilities: {
        prepare: filePrepare,
        attach: fileAttach,
        rollback: fileRollback,
      },
    } as const;

    const prepared = await prepareWorkspaceContentHandoff(context);
    await attachWorkspaceContentHandoff(context, prepared.payload);

    expect(prepared).toEqual({
      transferId: "file-transfer-1",
      payload: { document: fileDocument, buffer: fileBuffer },
    });
    expect(filePrepare).toHaveBeenCalledTimes(1);
    expect(fileAttach).toHaveBeenCalledWith(prepared.payload);
    expect(ptyDriver.prepareHandoff).not.toHaveBeenCalled();
    expect(ptyDriver.attachHandoff).not.toHaveBeenCalled();
    expect(ptyDriver.rollbackHandoff).not.toHaveBeenCalled();
  });
});

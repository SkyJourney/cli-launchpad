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

  afterEach(() => {
    unregister?.();
    unregister = undefined;
  });

  it("invokes adapter drivers with only the host-injected PTY capabilities", async () => {
    const prepare = vi.fn(async () => ({
      handoff: { token: "rust-token", sequence: 17 },
    }));
    const attach = vi.fn(async () => undefined);
    const rollback = vi.fn(async () => undefined);
    unregister = registerWorkspaceContentAdapter({
      id: "test.handoff-runtime",
      apiVersion: 1,
      kind: "pty",
      render: () => null,
      presentation: { labels },
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
      generation: 4,
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
});

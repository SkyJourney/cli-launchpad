import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceFileBufferPublisher } from "./workspaceFileBufferPublisher";
import type { WorkspaceFileBufferChange } from "./workspaceFileBufferPublisher";

const change = (content: string): WorkspaceFileBufferChange => ({
  documentId: "doc-1",
  token: "token-1",
  windowLabel: "workspace-content-11111111-1111-4111-8111-111111111111",
  fileBuffer: {
    kind: "text",
    epoch: 0,
    version: content.length,
    content,
    savedContent: "",
    revision: "revision",
    saving: false,
  },
});

afterEach(() => vi.useRealTimers());

describe("workspace file buffer publisher", () => {
  it("coalesces edits into a 150ms trailing update", async () => {
    vi.useFakeTimers();
    const send = vi.fn(
      async (_payload: WorkspaceFileBufferChange) => undefined,
    );
    const publisher = createWorkspaceFileBufferPublisher(send);

    publisher.publishLatest(change("a"));
    await vi.advanceTimersByTimeAsync(100);
    publisher.publishLatest(change("latest"));
    await vi.advanceTimersByTimeAsync(149);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(change("latest"));
  });

  it("flushes the latest buffer immediately and preserves send order", async () => {
    vi.useFakeTimers();
    let finishFirst: (() => void) | undefined;
    const send = vi
      .fn<(payload: WorkspaceFileBufferChange) => Promise<void>>()
      .mockImplementationOnce(
        (_payload) => new Promise((resolve) => (finishFirst = resolve)),
      )
      .mockResolvedValue(undefined);
    const publisher = createWorkspaceFileBufferPublisher(send);

    publisher.publishLatest(change("first"));
    const firstFlush = publisher.flush();
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
    publisher.publishLatest(change("latest"));
    const secondFlush = publisher.flush();
    expect(send).toHaveBeenCalledTimes(1);
    finishFirst?.();
    await Promise.all([firstFlush, secondFlush]);

    expect(send.mock.calls.map(([payload]) => payload)).toEqual([
      change("first"),
      change("latest"),
    ]);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  requestWorkspaceFileBufferFlush,
  type WorkspaceFileFlushResponse,
} from "./workspaceFileExitFlush";

const target = {
  documentId: "doc-1",
  token: "token-1",
  windowLabel: "workspace-content-1",
};

function response(requestId: string): WorkspaceFileFlushResponse {
  return {
    ...target,
    requestId,
    fileDocument: {
      id: target.documentId,
      directoryId: 1,
      directoryPath: "C:/project",
      relativePath: "notes.md",
    },
    fileBuffer: {
      kind: "text",
      epoch: 0,
      version: 1,
      content: "unsaved",
      savedContent: "saved",
      revision: "rev-1",
      saving: false,
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("workspace file exit flush", () => {
  it("returns the matching child buffer snapshot", async () => {
    let onResponse: ((value: WorkspaceFileFlushResponse) => void) | undefined;
    const result = requestWorkspaceFileBufferFlush({
      target,
      listen: async (handler) => {
        onResponse = handler;
        return vi.fn();
      },
      emit: async (requestId) => onResponse?.(response(requestId)),
    });

    await expect(result).resolves.toMatchObject({
      documentId: target.documentId,
      fileBuffer: { content: "unsaved" },
    });
  });

  it("treats a child that does not acknowledge within 500ms as unavailable", async () => {
    vi.useFakeTimers();
    const result = requestWorkspaceFileBufferFlush({
      target,
      listen: async () => vi.fn(),
      emit: async () => undefined,
    });

    await vi.advanceTimersByTimeAsync(500);
    await expect(result).resolves.toBeNull();
  });

  it("treats a synchronous listener failure as unavailable", async () => {
    const emit = vi.fn(async () => undefined);
    const result = requestWorkspaceFileBufferFlush({
      target,
      listen: () => {
        throw new Error("listener failed");
      },
      emit,
    });

    await expect(result).resolves.toBeNull();
    expect(emit).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from "vitest";
import {
  beginWorkspaceFileSave,
  completeWorkspaceFileSave,
  createWorkspaceFileBuffer,
  editWorkspaceFileBuffer,
  failWorkspaceFileSave,
  isWorkspaceFileBufferNewer,
  markWorkspaceFileSaveConflict,
  WorkspaceFileOperationFlights,
} from "./workspaceFileBuffer";

const textBuffer = (content = "original", revision = "revision") =>
  createWorkspaceFileBuffer({ kind: "text", content, revision });

describe("workspace file save transitions", () => {
  it("keeps edits typed while an earlier snapshot is being saved", () => {
    const edited = editWorkspaceFileBuffer(textBuffer(), "first draft");
    const submitted = beginWorkspaceFileSave(edited);
    const current = editWorkspaceFileBuffer(submitted, "newer draft");

    expect(
      completeWorkspaceFileSave(current, submitted, {
        content: "first draft",
        revision: "new-revision",
      }),
    ).toEqual({
      ...current,
      savedContent: "first draft",
      revision: "new-revision",
      saving: false,
      conflict: false,
      version: current.version + 1,
    });
  });

  it("preserves the current draft after a failed save", () => {
    const submitted = beginWorkspaceFileSave(
      editWorkspaceFileBuffer(textBuffer(), "submitted"),
    );
    const current = editWorkspaceFileBuffer(submitted, "latest");

    expect(failWorkspaceFileSave(current, submitted)).toEqual({
      ...current,
      saving: false,
      version: current.version + 1,
    });
  });

  it("marks a revision conflict without discarding the draft or saved baseline", () => {
    const submitted = beginWorkspaceFileSave(
      editWorkspaceFileBuffer(textBuffer(), "my draft"),
    );
    const current = editWorkspaceFileBuffer(submitted, "newer draft");

    expect(markWorkspaceFileSaveConflict(current, submitted)).toEqual({
      ...current,
      saving: false,
      conflict: true,
      version: current.version + 1,
    });
  });

  it("ignores a save completion from an older document epoch", () => {
    const submitted = beginWorkspaceFileSave(
      editWorkspaceFileBuffer(textBuffer(), "old draft"),
    );
    const reloaded = createWorkspaceFileBuffer(
      { kind: "text", content: "fresh disk", revision: "fresh-revision" },
      submitted.epoch + 1,
    );

    expect(
      completeWorkspaceFileSave(reloaded, submitted, {
        content: submitted.content,
        revision: "stale-revision",
      }),
    ).toBe(reloaded);
    expect(markWorkspaceFileSaveConflict(reloaded, submitted)).toBe(reloaded);
    expect(failWorkspaceFileSave(reloaded, submitted)).toBe(reloaded);
  });
});

describe("workspace file version ordering", () => {
  it("orders remote buffer events by epoch and then version", () => {
    const current = { ...textBuffer(), epoch: 2, version: 9 };
    expect(
      isWorkspaceFileBufferNewer({ ...current, version: 10 }, current),
    ).toBe(true);
    expect(isWorkspaceFileBufferNewer({ ...current, epoch: 3 }, current)).toBe(
      true,
    );
    expect(
      isWorkspaceFileBufferNewer({ ...current, version: 8 }, current),
    ).toBe(false);
    expect(
      isWorkspaceFileBufferNewer(
        { ...current, epoch: 1, version: 99 },
        current,
      ),
    ).toBe(false);
  });
});

describe("workspace file operation flights", () => {
  it("coalesces concurrent loads and releases the flight after settlement", async () => {
    const flights = new WorkspaceFileOperationFlights();
    let complete!: (value: string) => void;
    const operation = () =>
      new Promise<string>((resolve) => (complete = resolve));
    const first = flights.load("doc", operation);
    const second = flights.load("doc", operation);

    expect(second).toBe(first);
    expect(flights.isSaving("doc")).toBe(false);
    await Promise.resolve();
    complete("loaded");
    await expect(first).resolves.toBe("loaded");
    await expect(flights.load("doc", async () => "next load")).resolves.toBe(
      "next load",
    );
  });

  it("coalesces saves and exposes a barrier for handoff", async () => {
    const flights = new WorkspaceFileOperationFlights();
    let complete!: () => void;
    let operationCount = 0;
    const operation = () => {
      operationCount += 1;
      return new Promise<void>((resolve) => (complete = resolve));
    };
    const first = flights.save("doc", operation);
    const second = flights.save("doc", operation);

    expect(second).toBe(first);
    expect(flights.isSaving("doc")).toBe(true);
    expect(flights.waitForSave("doc")).toBe(first);
    expect(operationCount).toBe(1);
    complete();
    await expect(first).resolves.toBeUndefined();
    expect(flights.isSaving("doc")).toBe(false);
    await expect(flights.waitForSave("doc")).resolves.toBeUndefined();
  });
});

describe("workspace file open results", () => {
  it("turns a bounded image result into an inert data URL preview", () => {
    expect(
      createWorkspaceFileBuffer({
        kind: "image",
        mimeType: "image/png",
        base64Data: "cG5n",
      }),
    ).toEqual({
      kind: "image",
      epoch: 0,
      version: 0,
      content: "",
      savedContent: "",
      revision: "",
      saving: false,
      previewDataUrl: "data:image/png;base64,cG5n",
    });
  });

  it("keeps unsupported files clean and safe to close", () => {
    const buffer = createWorkspaceFileBuffer({
      kind: "unsupported",
      reason: "binary",
    });

    expect(buffer.kind).toBe("unsupported");
    expect(buffer.content).toBe(buffer.savedContent);
    expect(buffer.unsupportedReason).toBe("binary");
  });
});

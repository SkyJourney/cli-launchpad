import { describe, expect, it, vi } from "vitest";
import {
  createInitialHostSnapshot,
  WorkspaceHostStore,
} from "../host/workspaceHostStore";
import {
  createFileContentDomain,
  type FileContentDomainDeps,
} from "./fileContentDomain";

const DOC = {
  id: "d1",
  directoryId: 1,
  directoryPath: "C:/project",
  relativePath: "a.txt",
};
const REF = { kind: "file" as const, documentId: "d1" };

function buf(overrides: Record<string, unknown> = {}) {
  return {
    kind: "text",
    epoch: 0,
    version: 0,
    content: "a",
    savedContent: "a",
    revision: "r1",
    saving: false,
    conflict: false,
    ...overrides,
  } as never;
}

function makeDeps(
  overrides: Partial<FileContentDomainDeps> = {},
): FileContentDomainDeps {
  const store = new WorkspaceHostStore(createInitialHostSnapshot("p1"));
  store.commit(
    (live) => ({ ...live, documents: [DOC], buffers: { d1: buf() } }),
    "test:seed",
  );
  return {
    store,
    fileDomain: {
      closeDocuments: vi.fn(() => ({ closedDocumentIds: ["d1"] })),
    } as never,
    isWindowOwned: () => false,
    isHandoffActive: () => false,
    ...overrides,
  };
}

describe("fileContentDomain", () => {
  it("closeInput is undefined for a missing document", () => {
    const domain = createFileContentDomain(makeDeps());

    expect(
      domain.closeInput({ kind: "file", documentId: "nope" }),
    ).toBeUndefined();
    // 反向：存在的文档有关闭输入。
    expect(domain.closeInput(REF)).not.toBeUndefined();
  });

  it("closeInput is undefined for window-owned content", () => {
    const domain = createFileContentDomain(
      makeDeps({ isWindowOwned: () => true }),
    );

    expect(domain.closeInput(REF)).toBeUndefined();
  });

  it("closeInput is undefined while a handoff is active", () => {
    const domain = createFileContentDomain(
      makeDeps({ isHandoffActive: () => true }),
    );

    expect(domain.closeInput(REF)).toBeUndefined();
  });

  it("closeInput reports a clean document with its relative path as title", () => {
    const domain = createFileContentDomain(makeDeps());

    expect(domain.closeInput(REF)).toEqual({
      title: "a.txt",
      isDirty: false,
      isRunning: false,
    });
  });

  it.each([
    ["content differs from the saved content", { content: "b" }],
    ["a save is in flight", { saving: true }],
    ["a conflict is recorded", { conflict: true }],
    ["the project identity changed", { identityChanged: true }],
  ])("closeInput reports dirty when %s", (_label, overrides) => {
    const deps = makeDeps();
    deps.store.commit(
      (live) => ({ ...live, buffers: { d1: buf(overrides) } }),
      "test:dirty",
    );
    const domain = createFileContentDomain(deps);

    expect(domain.closeInput(REF)).toEqual({
      title: "a.txt",
      isDirty: true,
      isRunning: false,
    });
  });

  it("closeInput treats a missing buffer as clean", () => {
    const deps = makeDeps();
    deps.store.commit((live) => ({ ...live, buffers: {} }), "test:no-buffer");
    const domain = createFileContentDomain(deps);

    expect(domain.closeInput(REF)).toEqual({
      title: "a.txt",
      isDirty: false,
      isRunning: false,
    });
  });

  it("close delegates to closeDocuments and maps the closed ids to refs", async () => {
    const deps = makeDeps();
    const domain = createFileContentDomain(deps);

    await expect(domain.close([REF], "menu")).resolves.toEqual({
      closed: [{ kind: "file", documentId: "d1" }],
      pending: [],
      failed: [],
    });
    expect(deps.fileDomain.closeDocuments).toHaveBeenCalledTimes(1);
    expect(deps.fileDomain.closeDocuments).toHaveBeenCalledWith(["d1"]);
  });

  it("close reports nothing closed when closeDocuments closes nothing", async () => {
    const domain = createFileContentDomain(
      makeDeps({
        fileDomain: {
          closeDocuments: vi.fn(() => ({ closedDocumentIds: [] })),
        } as never,
      }),
    );

    await expect(domain.close([REF], "tab")).resolves.toEqual({
      closed: [],
      pending: [],
      failed: [],
    });
  });
});

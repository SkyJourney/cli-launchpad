import type { TFunction } from "i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  listWorkspacePanes,
  createWorkspacePane,
} from "../../lib/ptyWorkspaceLayout";
import {
  openProjectFile,
  saveProjectTextFile,
  type WorkspaceFileDocument,
} from "../../lib/tauri";
import {
  addWorkspaceFileToPane,
  type WorkspaceNode,
} from "../../lib/ptyWorkspaceLayout";
import type { WorkspaceFileBuffer } from "../../lib/workspaceFileBuffer";
import {
  createInitialHostSnapshot,
  WorkspaceHostStore,
} from "../host/workspaceHostStore";
import {
  createFileDocumentsDomain,
  type FileDocumentsDomainServices,
} from "./fileDocumentsDomain";

vi.mock("../../lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/tauri")>();
  return {
    ...actual,
    openProjectFile: vi.fn(),
    saveProjectTextFile: vi.fn(),
  };
});

const DOC: WorkspaceFileDocument = {
  id: "d1",
  directoryId: 1,
  directoryPath: "C:/project",
  relativePath: "a.txt",
};

function text(content: string, revision: string) {
  return { kind: "text" as const, content, revision };
}

function makeStore(
  documents: WorkspaceFileDocument[] = [],
  buffers: Record<string, WorkspaceFileBuffer> = {},
) {
  const store = new WorkspaceHostStore(createInitialHostSnapshot("p1"));
  store.commit((live) => ({ ...live, documents, buffers }), "test:seed");
  return store;
}

function makeServices(
  overrides: Partial<FileDocumentsDomainServices> = {},
): FileDocumentsDomainServices {
  return {
    isRestoreInProgress: () => false,
    getHydrationEpoch: () => 0,
    isHandoffActive: () => false,
    getTranslate: () => ((key: string) => key) as unknown as TFunction,
    notify: { error: vi.fn(), warning: vi.fn() },
    ...overrides,
  };
}

function buffer(
  content: string,
  savedContent: string,
  revision = "r1",
  version = 0,
): WorkspaceFileBuffer {
  return {
    kind: "text",
    epoch: 0,
    version,
    content,
    savedContent,
    revision,
    saving: false,
    conflict: false,
  } as WorkspaceFileBuffer;
}

function savableStore() {
  return makeStore([DOC], { d1: buffer("edited", "hello", "r1", 1) });
}

function newGate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

const ARGS = {
  directoryId: 1,
  directoryPath: "C:/project",
  relativePath: "a.txt",
};

beforeEach(() => {
  vi.mocked(openProjectFile).mockReset();
  vi.mocked(saveProjectTextFile).mockReset();
});

describe("fileDocumentsDomain", () => {
  it("open creates one document and buffer for concurrent identical requests and places it once", async () => {
    const store = makeStore();
    const domain = createFileDocumentsDomain(store, makeServices());
    const gate = newGate<ReturnType<typeof text>>();
    vi.mocked(openProjectFile).mockReturnValue(gate.promise as never);
    const place = vi.fn();

    const p1 = domain.open(ARGS, place);
    const p2 = domain.open(ARGS, place);
    gate.resolve(text("hello", "r1"));
    await Promise.all([p1, p2]);

    expect(p2).toBe(p1);
    expect(openProjectFile).toHaveBeenCalledTimes(1);
    expect(place).toHaveBeenCalledTimes(1);
    expect(place.mock.calls[0]?.[0]).toMatchObject({
      directoryId: 1,
      directoryPath: "C:/project",
      relativePath: "a.txt",
    });
    const id = place.mock.calls[0]?.[0].id as string;
    expect(id).toBeTruthy();
    expect(store.getSnapshot().documents).toHaveLength(1);
    expect(store.getSnapshot().buffers[id]).toMatchObject({
      kind: "text",
      content: "hello",
      savedContent: "hello",
      revision: "r1",
      epoch: 0,
      version: 0,
      saving: false,
    });

    await domain.open(ARGS, place);
    expect(openProjectFile).toHaveBeenCalledTimes(1);
    expect(place).toHaveBeenCalledTimes(2);
  });

  it("open loads the buffer of a restored document that has none and places the existing document", async () => {
    const store = makeStore([DOC], {});
    const domain = createFileDocumentsDomain(store, makeServices());
    vi.mocked(openProjectFile).mockResolvedValue(text("disk", "r5") as never);
    const place = vi.fn();

    await domain.open(ARGS, place);

    expect(openProjectFile).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().documents).toHaveLength(1);
    expect(store.getSnapshot().buffers.d1).toMatchObject({
      content: "disk",
      revision: "r5",
    });
    expect(place).toHaveBeenCalledTimes(1);
    expect(place.mock.calls[0]?.[0]).toBe(store.getSnapshot().documents[0]);
  });

  it("open discards the result and does not place when a hydration started in between", async () => {
    const store = makeStore();
    let epoch = 0;
    const domain = createFileDocumentsDomain(
      store,
      makeServices({ getHydrationEpoch: () => epoch }),
    );
    const gate = newGate<ReturnType<typeof text>>();
    vi.mocked(openProjectFile).mockReturnValue(gate.promise as never);
    const place = vi.fn();

    const p = domain.open(ARGS, place);
    epoch = 1;
    gate.resolve(text("hello", "r1"));
    await p;

    expect(place).not.toHaveBeenCalled();
    expect(store.getSnapshot().documents).toEqual([]);
    expect(store.getSnapshot().buffers).toEqual({});
  });

  it("open does nothing while a restore is in progress", async () => {
    const store = makeStore();
    const domain = createFileDocumentsDomain(
      store,
      makeServices({ isRestoreInProgress: () => true }),
    );
    const place = vi.fn();
    const before = store.commitCount;

    await domain.open(ARGS, place);

    expect(openProjectFile).not.toHaveBeenCalled();
    expect(place).not.toHaveBeenCalled();
    expect(store.commitCount).toBe(before);
  });

  it("open discards the loaded buffer of an existing document after invalidateLoads", async () => {
    const store = makeStore([DOC], {});
    const domain = createFileDocumentsDomain(store, makeServices());
    const gate = newGate<ReturnType<typeof text>>();
    vi.mocked(openProjectFile).mockReturnValue(gate.promise as never);
    const place = vi.fn();

    const p = domain.open(ARGS, place);
    domain.invalidateLoads(["d1"]);
    gate.resolve(text("late", "r9"));
    await p;

    expect(store.getSnapshot().buffers.d1).toBeUndefined();
    expect(place).not.toHaveBeenCalled();

    // 反向：没有 invalidateLoads 时同样流程会写入缓冲并放置文档。
    const store2 = makeStore([DOC], {});
    const domain2 = createFileDocumentsDomain(store2, makeServices());
    const gate2 = newGate<ReturnType<typeof text>>();
    vi.mocked(openProjectFile).mockReturnValue(gate2.promise as never);
    const place2 = vi.fn();
    const p2 = domain2.open(ARGS, place2);
    gate2.resolve(text("late", "r9"));
    await p2;
    expect(store2.getSnapshot().buffers.d1?.content).toBe("late");
    expect(place2).toHaveBeenCalledTimes(1);
  });

  it("load is single-flight and skips documents that already have a buffer", async () => {
    const store = makeStore([DOC], {});
    const domain = createFileDocumentsDomain(store, makeServices());
    vi.mocked(openProjectFile).mockResolvedValue(text("disk", "r5") as never);

    await Promise.all([domain.load("d1"), domain.load("d1")]);
    expect(openProjectFile).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().buffers.d1?.content).toBe("disk");

    await domain.load("d1");
    expect(openProjectFile).toHaveBeenCalledTimes(1);

    // 反向：不存在的文档不抛错，也不调用 openProjectFile。
    await expect(domain.load("missing")).resolves.toBeUndefined();
    expect(openProjectFile).toHaveBeenCalledTimes(1);
  });

  it("load discards the result after invalidateLoads", async () => {
    const store = makeStore([DOC], {});
    const domain = createFileDocumentsDomain(store, makeServices());
    const gate = newGate<ReturnType<typeof text>>();
    vi.mocked(openProjectFile).mockReturnValue(gate.promise as never);

    const p = domain.load("d1");
    domain.invalidateLoads(["d1"]);
    gate.resolve(text("late", "r9"));
    await p;

    expect(store.getSnapshot().buffers.d1).toBeUndefined();
  });

  it("edit replaces the content, bumps the version and clears the conflict flag", () => {
    const store = makeStore([DOC], {
      d1: { ...buffer("a", "a"), conflict: true } as WorkspaceFileBuffer,
    });
    const domain = createFileDocumentsDomain(store, makeServices());

    domain.edit("d1", "b");

    expect(store.getSnapshot().buffers.d1).toMatchObject({
      content: "b",
      savedContent: "a",
      version: 1,
      conflict: false,
    });

    // 反向：编辑不存在的文档不抛错，缓冲键集合不变。
    domain.edit("missing", "x");
    expect(Object.keys(store.getSnapshot().buffers)).toEqual(["d1"]);
  });

  it("edit is ignored while a restore is in progress or the document handoff is active", () => {
    const restoring = makeStore([DOC], { d1: buffer("a", "a") });
    createFileDocumentsDomain(
      restoring,
      makeServices({ isRestoreInProgress: () => true }),
    ).edit("d1", "b");
    const handoff = makeStore([DOC], { d1: buffer("a", "a") });
    createFileDocumentsDomain(
      handoff,
      makeServices({ isHandoffActive: () => true }),
    ).edit("d1", "b");

    expect(restoring.getSnapshot().buffers.d1?.content).toBe("a");
    expect(handoff.getSnapshot().buffers.d1?.content).toBe("a");

    // 反向：无限制的 domain 同样调用后内容为 "b"。
    const free = makeStore([DOC], { d1: buffer("a", "a") });
    createFileDocumentsDomain(free, makeServices()).edit("d1", "b");
    expect(free.getSnapshot().buffers.d1?.content).toBe("b");
  });

  it("save writes text through saveProjectTextFile and completes the buffer", async () => {
    const store = savableStore();
    const services = makeServices();
    const domain = createFileDocumentsDomain(store, services);
    vi.mocked(saveProjectTextFile).mockResolvedValue({
      kind: "saved",
      content: "edited",
      revision: "r2",
      warning: null,
    } as never);

    await domain.save("d1");

    expect(saveProjectTextFile).toHaveBeenCalledWith(
      1,
      "C:/project",
      "a.txt",
      "edited",
      "r1",
    );
    expect(store.getSnapshot().buffers.d1).toMatchObject({
      saving: false,
      savedContent: "edited",
      revision: "r2",
      content: "edited",
      conflict: false,
    });
    expect(services.notify.error).not.toHaveBeenCalled();
    expect(services.notify.warning).not.toHaveBeenCalled();

    // 反向：带 permissionsNotRestored 警告的保存会提示一次。
    const store2 = savableStore();
    const services2 = makeServices();
    vi.mocked(saveProjectTextFile).mockResolvedValue({
      kind: "saved",
      content: "edited",
      revision: "r2",
      warning: "permissionsNotRestored",
    } as never);
    await createFileDocumentsDomain(store2, services2).save("d1");
    expect(services2.notify.warning).toHaveBeenCalledWith(
      "workspaceFiles.permissionsNotRestored",
    );
  });

  it("save conflict marks the buffer and offers a reload action", async () => {
    const store = savableStore();
    const services = makeServices();
    vi.mocked(saveProjectTextFile).mockResolvedValue({
      kind: "conflict",
    } as never);

    await createFileDocumentsDomain(store, services).save("d1");

    expect(store.getSnapshot().buffers.d1).toMatchObject({
      conflict: true,
      saving: false,
      content: "edited",
    });
    expect(services.notify.error).toHaveBeenCalledTimes(1);
    const [message, options] =
      vi.mocked(services.notify.error).mock.calls[0] ?? [];
    expect(message).toBe("workspaceFiles.saveConflict");
    expect(options).toMatchObject({
      action: { label: "workspaceFiles.reload" },
    });
    expect(typeof options?.action?.onClick).toBe("function");
  });

  it("save marks a project identity change and blocks further saves", async () => {
    const store = savableStore();
    const services = makeServices();
    vi.mocked(saveProjectTextFile).mockRejectedValueOnce({
      code: "project_identity_changed",
      message: "x",
    });
    const domain = createFileDocumentsDomain(store, services);

    await domain.save("d1");

    expect(store.getSnapshot().buffers.d1).toMatchObject({
      identityChanged: true,
      conflict: true,
      saving: false,
    });
    expect(services.notify.error).toHaveBeenCalledWith(
      "workspaceFiles.projectIdentityChanged",
    );
    await domain.save("d1");
    expect(saveProjectTextFile).toHaveBeenCalledTimes(1);
  });

  it("save restores the draft after a generic failure", async () => {
    const store = savableStore();
    const services = makeServices();
    vi.mocked(saveProjectTextFile).mockRejectedValueOnce(
      new Error("disk full"),
    );

    await createFileDocumentsDomain(store, services).save("d1");

    expect(store.getSnapshot().buffers.d1).toMatchObject({
      saving: false,
      content: "edited",
    });
    expect(services.notify.error).toHaveBeenCalledWith(
      expect.stringContaining("disk full"),
    );
    // 反向：通用失败既不是身份变化也不是冲突。
    expect(store.getSnapshot().buffers.d1?.identityChanged).not.toBe(true);
    expect(store.getSnapshot().buffers.d1?.conflict).not.toBe(true);
  });

  it("save is skipped for clean, saving, identity-changed and non-text buffers", async () => {
    const clean = makeStore([DOC], { d1: buffer("a", "a") });
    const saving = makeStore([DOC], {
      d1: { ...buffer("b", "a"), saving: true } as WorkspaceFileBuffer,
    });
    const changed = makeStore([DOC], {
      d1: { ...buffer("b", "a"), identityChanged: true } as WorkspaceFileBuffer,
    });
    const image = makeStore([DOC], {
      d1: {
        kind: "image",
        epoch: 0,
        version: 0,
        content: "",
        savedContent: "",
        revision: "",
        saving: false,
        previewDataUrl: "data:image/png;base64,AA==",
      } as unknown as WorkspaceFileBuffer,
    });
    const before = [clean, saving, changed, image].map(
      (s) => s.getSnapshot().buffers.d1,
    );

    for (const store of [clean, saving, changed, image]) {
      await createFileDocumentsDomain(store, makeServices()).save("d1");
    }
    expect(saveProjectTextFile).not.toHaveBeenCalled();
    [clean, saving, changed, image].forEach((store, index) => {
      expect(store.getSnapshot().buffers.d1).toBe(before[index]);
    });

    // 反向：有改动的文本缓冲会触发一次保存。
    const dirty = makeStore([DOC], { d1: buffer("b", "a") });
    vi.mocked(saveProjectTextFile).mockResolvedValue({
      kind: "saved",
      content: "b",
      revision: "r2",
      warning: null,
    } as never);
    await createFileDocumentsDomain(dirty, makeServices()).save("d1");
    expect(saveProjectTextFile).toHaveBeenCalledTimes(1);
  });

  it("save coalesces concurrent calls into one backend write", async () => {
    const store = makeStore([DOC], { d1: buffer("edited", "hello", "r1", 1) });
    const domain = createFileDocumentsDomain(store, makeServices());
    const gate = newGate<unknown>();
    vi.mocked(saveProjectTextFile).mockReturnValue(gate.promise as never);

    const p1 = domain.save("d1");
    const p2 = domain.save("d1");
    expect(store.getSnapshot().buffers.d1?.saving).toBe(true);
    gate.resolve({
      kind: "saved",
      content: "edited",
      revision: "r2",
      warning: null,
    });
    await Promise.all([p1, p2]);

    expect(p2).toBe(p1);
    expect(saveProjectTextFile).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().buffers.d1?.saving).toBe(false);
  });

  it("closeDocuments removes tree entries, documents and buffers in one commit and invalidates loads", async () => {
    const d2: WorkspaceFileDocument = {
      ...DOC,
      id: "d2",
      relativePath: "b.txt",
    };
    const pane = addWorkspaceFileToPane(
      addWorkspaceFileToPane(createWorkspacePane("p1"), "p1", "d1"),
      "p1",
      "d2",
    );
    const store = new WorkspaceHostStore(createInitialHostSnapshot("p1"));
    store.commit(
      (live) => ({
        ...live,
        tree: pane,
        documents: [DOC, d2],
        buffers: { d1: buffer("a", "a"), d2: buffer("b", "b") },
      }),
      "test:seed",
    );
    const domain = createFileDocumentsDomain(store, makeServices());
    const before = store.commitCount;

    const result = domain.closeDocuments(["d1"]);

    expect(result.closedDocumentIds).toEqual(["d1"]);
    expect(store.getSnapshot().documents.map((d) => d.id)).toEqual(["d2"]);
    expect(Object.keys(store.getSnapshot().buffers)).toEqual(["d2"]);
    const panes = listWorkspacePanes(store.getSnapshot().tree);
    expect(
      panes[0]?.contents.some(
        (c) => c.kind === "file" && c.documentId === "d1",
      ),
    ).toBe(false);
    expect(store.commitCount).toBe(before + 1);

    // 反向：关闭不存在的文档不产生提交。
    const noop = domain.closeDocuments(["nope"]);
    expect(noop.closedDocumentIds).toEqual([]);
    expect(store.commitCount).toBe(before + 1);

    // 拖拽中关闭不存在的文档不发布临时树。
    store.setTransientTree(createWorkspacePane("drag-pane"));
    const publishedTree = store.getSnapshot().tree;
    domain.closeDocuments(["nope"]);
    expect(store.getSnapshot().tree).toBe(publishedTree);
    expect(store.getLive().tree.id).toBe("drag-pane");

    // 关闭使挂起的加载失效。
    const store2 = makeStore([DOC], {});
    const domain2 = createFileDocumentsDomain(store2, makeServices());
    const gate = newGate<ReturnType<typeof text>>();
    vi.mocked(openProjectFile).mockReturnValue(gate.promise as never);
    const pending = domain2.load("d1");
    domain2.closeDocuments(["d1"]);
    gate.resolve(text("late", "r9"));
    await pending;
    expect(store2.getSnapshot().buffers.d1).toBeUndefined();
  });

  it("reload replaces the buffer with the next epoch from disk", async () => {
    const store = makeStore([DOC], { d1: buffer("edited", "hello", "r1", 3) });
    const domain = createFileDocumentsDomain(store, makeServices());
    vi.mocked(openProjectFile).mockResolvedValue(text("disk", "r9") as never);

    await domain.reload("d1");

    expect(store.getSnapshot().buffers.d1).toMatchObject({
      epoch: 1,
      content: "disk",
      savedContent: "disk",
      revision: "r9",
      version: 0,
    });

    // 反向：不存在的文档不抛错，也不调用 openProjectFile。
    vi.mocked(openProjectFile).mockClear();
    await expect(domain.reload("missing")).resolves.toBeUndefined();
    expect(openProjectFile).not.toHaveBeenCalled();
  });

  it("mergeBuffers replaces only the listed buffers in one commit", () => {
    const store = makeStore([DOC, { ...DOC, id: "d2" }], {
      d1: buffer("a", "a"),
      d2: buffer("b", "b"),
    });
    const domain = createFileDocumentsDomain(store, makeServices());
    const before = store.commitCount;
    const d2Before = store.getSnapshot().buffers.d2;

    domain.mergeBuffers({ d1: buffer("new", "a", "r1", 5) }, "test:merge");

    expect(store.getSnapshot().buffers.d1?.content).toBe("new");
    expect(store.getSnapshot().buffers.d2).toBe(d2Before);
    expect(store.commitCount).toBe(before + 1);
    expect(store.lastReason).toBe("test:merge");

    // 反向：空对象仍会提交一次（buffers 是新对象），这是预期行为。
    domain.mergeBuffers({}, "noop");
    expect(store.commitCount).toBe(before + 2);
  });
});

describe("fileDocumentsDomain case variants", () => {
  const INSENSITIVE = {
    case: "insensitive",
    normalizationInsensitive: "no",
  } as const;
  const lower: WorkspaceFileDocument = {
    ...DOC,
    id: "d1",
    relativePath: "a.txt",
  };
  const upper: WorkspaceFileDocument = {
    ...DOC,
    id: "d2",
    relativePath: "A.txt",
  };

  /** Both documents shown in one pane, as after a hydrate that kept exact paths only. */
  function seeded(
    options: {
      shown?: string[];
      buffers?: Record<string, WorkspaceFileBuffer>;
    } = {},
  ) {
    let tree: WorkspaceNode = createWorkspacePane("p1");
    for (const id of options.shown ?? ["d1", "d2"]) {
      tree = addWorkspaceFileToPane(tree, "p1", id);
    }
    const store = new WorkspaceHostStore(createInitialHostSnapshot("p1"));
    store.commit(
      (live) => ({
        ...live,
        tree,
        documents: [lower, upper],
        buffers: options.buffers ?? {
          d1: buffer("a", "a"),
          d2: buffer("A", "A"),
        },
      }),
      "test:seed",
    );
    return store;
  }

  function domainOf(
    store: WorkspaceHostStore,
    overrides: Partial<FileDocumentsDomainServices> = {},
  ) {
    const compareFileIdentity = vi.fn().mockResolvedValue("same");
    const releaseDocuments = vi.fn();
    const services = makeServices({
      getPathSemantics: () => INSENSITIVE,
      compareFileIdentity,
      releaseDocuments,
      ...overrides,
    });
    return {
      domain: createFileDocumentsDomain(store, services),
      compareFileIdentity,
      releaseDocuments,
    };
  }

  const shownIds = (store: WorkspaceHostStore) =>
    listWorkspacePanes(store.getSnapshot().tree).flatMap((pane) =>
      pane.contents.flatMap((content) =>
        content.kind === "file" ? [content.documentId] : [],
      ),
    );

  it("merges a confirmed group in one commit and releases the variant", async () => {
    const store = seeded();
    const { domain, compareFileIdentity, releaseDocuments } = domainOf(store);
    const before = store.commitCount;

    const merged = await domain.mergeCaseVariants(1, "C:/project", 0);

    expect(merged).toBe(1);
    expect(store.commitCount).toBe(before + 1);
    expect(store.getSnapshot().documents.map((entry) => entry.id)).toEqual([
      "d1",
    ]);
    expect(Object.keys(store.getSnapshot().buffers)).toEqual(["d1"]);
    expect(shownIds(store)).toEqual(["d1"]);
    expect(compareFileIdentity).toHaveBeenCalledWith(
      1,
      "C:/project",
      "a.txt",
      "A.txt",
    );
    expect(releaseDocuments).toHaveBeenCalledWith(["d2"]);
  });

  it("keeps the variant when the backend says it is another file", async () => {
    const store = seeded();
    const { domain } = domainOf(store, {
      compareFileIdentity: vi.fn().mockResolvedValue("different"),
    });
    const before = store.commitCount;

    expect(await domain.mergeCaseVariants(1, "C:/project", 0)).toBe(0);
    expect(store.commitCount).toBe(before);
    expect(store.getSnapshot().documents).toHaveLength(2);
  });

  it("discards the merge when a hydration starts while the identity is checked", async () => {
    const store = seeded();
    const gate = newGate<"same">();
    let epoch = 0;
    const { domain } = domainOf(store, {
      getHydrationEpoch: () => epoch,
      compareFileIdentity: vi.fn().mockReturnValue(gate.promise),
    });
    const before = store.commitCount;

    const pending = domain.mergeCaseVariants(1, "C:/project", 0);
    epoch = 1;
    gate.resolve("same");

    expect(await pending).toBe(0);
    expect(store.commitCount).toBe(before);
    expect(store.getSnapshot().documents).toHaveLength(2);
  });

  it("leaves a group alone when a member is not shown in a pane or is in a handoff", async () => {
    // d2 belongs to another window: it is in the document list but in no pane.
    const outside = seeded({ shown: ["d1"] });
    expect(
      await domainOf(outside).domain.mergeCaseVariants(1, "C:/project", 0),
    ).toBe(0);
    expect(outside.getSnapshot().documents).toHaveLength(2);

    const handoff = seeded();
    const { domain } = domainOf(handoff, {
      isHandoffActive: (id) => id === "d2",
    });
    expect(await domain.mergeCaseVariants(1, "C:/project", 0)).toBe(0);
    expect(handoff.getSnapshot().documents).toHaveLength(2);
  });

  it("keeps a variant with unsaved edits and merges once it is saved", async () => {
    const edited = seeded({
      buffers: { d1: buffer("a", "a"), d2: buffer("changed", "A") },
    });
    const first = domainOf(edited);
    expect(await first.domain.mergeCaseVariants(1, "C:/project", 0)).toBe(0);
    expect(edited.getSnapshot().buffers.d2?.content).toBe("changed");
    // The backend was asked: the unsaved edits are what kept the group.
    expect(first.compareFileIdentity).toHaveBeenCalled();

    const clean = seeded();
    expect(
      await domainOf(clean).domain.mergeCaseVariants(1, "C:/project", 0),
    ).toBe(1);
  });

  it("does not merge anything for a project that is not known to be insensitive", async () => {
    const store = seeded();
    const { domain, compareFileIdentity } = domainOf(store, {
      getPathSemantics: () => ({
        case: "unknown",
        normalizationInsensitive: "unknown",
      }),
    });
    expect(await domain.mergeCaseVariants(1, "C:/project", 0)).toBe(0);
    expect(compareFileIdentity).not.toHaveBeenCalled();
  });

  it("degrade drops the later variant without asking the backend, except one with unsaved edits", () => {
    const store = seeded();
    const { domain, compareFileIdentity } = domainOf(store);
    expect(domain.degradeCaseVariants(["d1", "d2"])).toBe(1);
    expect(store.getSnapshot().documents.map((entry) => entry.id)).toEqual([
      "d1",
    ]);
    expect(compareFileIdentity).not.toHaveBeenCalled();

    const edited = seeded({
      buffers: { d1: buffer("a", "a"), d2: buffer("changed", "A") },
    });
    expect(domainOf(edited).domain.degradeCaseVariants(["d1", "d2"])).toBe(0);
    expect(edited.getSnapshot().documents).toHaveLength(2);

    // Reverse: documents that are not named are left alone.
    const unrelated = seeded();
    expect(domainOf(unrelated).domain.degradeCaseVariants(["other"])).toBe(0);
  });
});

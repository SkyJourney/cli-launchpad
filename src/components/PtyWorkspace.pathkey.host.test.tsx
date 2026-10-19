// @vitest-environment jsdom
import { act, cleanup } from "@testing-library/react";
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

import type { FileIdentityComparison, PathSemantics } from "../lib/tauri";
import { validateWorkspaceLayoutDocument } from "../lib/workspaceLayoutPersistence";
import { tauriMock } from "../test/tauriMock";
import { resetFakeTerminals, toastSpy } from "../test/host/hostMocks";
import {
  createBackend,
  DIRECTORY,
  flush,
  invokes,
  mountWorkspace,
  type HostBackend,
  type WorkspaceHost,
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

const INSENSITIVE: PathSemantics = {
  case: "insensitive",
  normalizationInsensitive: "no",
};
const SENSITIVE: PathSemantics = {
  case: "sensitive",
  normalizationInsensitive: "no",
};
const UNKNOWN: PathSemantics = {
  case: "unknown",
  normalizationInsensitive: "unknown",
};

const D1 = "00000000-0000-4000-8000-000000000001";
const D2 = "00000000-0000-4000-8000-000000000002";
const D3 = "00000000-0000-4000-8000-000000000003";
const D4 = "00000000-0000-4000-8000-000000000004";

function addFiles(backend: HostBackend, names: string[]) {
  for (const name of names) {
    backend.files.set(name, { content: name, revision: "r1" });
  }
}

function useSemantics(
  backend: HostBackend,
  semantics: PathSemantics | (() => Promise<PathSemantics>),
) {
  backend.handlers.set("get_project_path_semantics", () =>
    typeof semantics === "function" ? semantics() : semantics,
  );
}

/** Identity answers by "<canonical>|<variant>" key; anything else is "different". */
function useIdentity(
  backend: HostBackend,
  answers: { current: Record<string, FileIdentityComparison> },
) {
  backend.handlers.set(
    "check_project_files_same_identity",
    (args: { a: string; b: string }) =>
      answers.current[`${args.a}|${args.b}`] ?? "different",
  );
}

async function open(host: WorkspaceHost, path: string) {
  await act(async () => {
    await host.ctx().openProjectFile(DIRECTORY.id, DIRECTORY.path, path);
  });
  await flush();
}

function paths(host: WorkspaceHost) {
  return host
    .ctx()
    .fileDocuments.map((document) => document.relativePath)
    .sort();
}

/** A ready layout with the given file documents, one per pane (split left to right). */
function layoutWith(documents: Array<[string, string]>): HostBackend["layout"] {
  const pane = (index: number, id: string) => ({
    kind: "pane" as const,
    id: `pane-${index}`,
    paneNumber: index + 1,
    contents: [{ kind: "file" as const, documentId: id }],
    activeContent: { kind: "file" as const, documentId: id },
  });
  let tree: unknown = pane(0, documents[0][0]);
  documents.slice(1).forEach(([id], offset) => {
    tree = {
      kind: "split",
      id: `split-${offset + 1}`,
      direction: "horizontal",
      ratio: 0.5,
      first: tree,
      second: pane(offset + 1, id),
    };
  });
  return {
    status: { status: "ready" },
    revision: 1,
    schemaVersion: 5,
    updatedAtMs: 1,
    layout: {
      schemaVersion: 5,
      tree,
      focusedPaneId: "pane-0",
      slots: [],
      documents: documents.map(([id, relativePath]) => ({
        id,
        directoryId: DIRECTORY.id,
        directoryPath: DIRECTORY.path,
        relativePath,
      })),
      detachedContents: [],
    },
    slotStates: [],
  } as HostBackend["layout"];
}

describe("document identity with path semantics", () => {
  it.each([
    ["sensitive", SENSITIVE, "different", 2, 0],
    ["unknown", UNKNOWN, "same", 1, 1],
    ["unknown", UNKNOWN, "different", 2, 1],
    ["insensitive", INSENSITIVE, "unavailable", 1, 1],
    ["insensitive", INSENSITIVE, "different", 2, 1],
    ["insensitive", INSENSITIVE, "same", 1, 1],
  ] as const)(
    "opens the same file in two cases according to the flag and identity check: %s / %s",
    async (_label, semantics, identity, expectedDocuments, expectedChecks) => {
      const backend = createBackend();
      addFiles(backend, ["A.txt"]);
      useSemantics(backend, semantics);
      useIdentity(backend, { current: { "a.txt|A.txt": identity } });
      host = await mountWorkspace({ backend });

      await open(host, "a.txt");
      await open(host, "A.txt");

      expect(host.ctx().fileDocuments).toHaveLength(expectedDocuments);
      if (expectedDocuments === 1) {
        // The existing document is focused and keeps its literal path.
        expect(paths(host)).toEqual(["a.txt"]);
      } else {
        expect(paths(host)).toEqual(["A.txt", "a.txt"]);
      }
      // Reverse: a sensitive project never asks the backend for an identity.
      expect(invokes("check_project_files_same_identity")).toHaveLength(
        expectedChecks,
      );
      expect(host.errors).toEqual([]);
    },
  );

  it("keeps exact dedupe at hydrate and merges case variants after the semantics arrive", async () => {
    const backend = createBackend(
      layoutWith([
        [D1, "a.txt"],
        [D2, "A.txt"],
      ]),
    );
    addFiles(backend, ["A.txt"]);
    let release: (value: PathSemantics) => void = () => undefined;
    useSemantics(
      backend,
      () =>
        new Promise<PathSemantics>((resolve) => {
          release = resolve;
        }),
    );
    useIdentity(backend, { current: { "a.txt|A.txt": "same" } });
    host = await mountWorkspace({ backend });
    await flush();

    // Hydrate only dedupes exact paths: both documents are there while the probe is pending.
    expect(host.ctx().hydrationStatus).toBe("ready");
    expect(paths(host)).toEqual(["A.txt", "a.txt"]);
    expect(invokes("check_project_files_same_identity")).toHaveLength(0);

    const before = host.store().commitCount;
    await act(async () => {
      release(INSENSITIVE);
    });
    await flush();

    expect(paths(host)).toEqual(["a.txt"]);
    // One commit for the whole merge.
    expect(host.store().commitCount - before).toBe(1);
    const panes = JSON.stringify(host.store().getLive().tree);
    expect(panes).toContain(D1);
    expect(panes).not.toContain(D2);
    expect(toastSpy.info).toHaveBeenCalledTimes(1);
    // The layout the host would save next is valid and holds one document.
    const last = backend.saved[backend.saved.length - 1]?.layout;
    expect(last).toBeDefined();
    expect(() => validateWorkspaceLayoutDocument(last!)).not.toThrow();
    expect(last!.documents.map((document) => document.relativePath)).toEqual([
      "a.txt",
    ]);
  });

  it("does not merge when the semantics are unknown or a variant has unsaved edits", async () => {
    // Unknown: nothing to merge, nothing asked.
    const backend = createBackend(
      layoutWith([
        [D1, "a.txt"],
        [D2, "A.txt"],
      ]),
    );
    addFiles(backend, ["A.txt"]);
    useSemantics(backend, UNKNOWN);
    useIdentity(backend, { current: { "a.txt|A.txt": "same" } });
    host = await mountWorkspace({ backend });
    await flush();
    expect(paths(host)).toEqual(["A.txt", "a.txt"]);
    expect(invokes("check_project_files_same_identity")).toHaveLength(0);
    host.dispose();
    host = undefined;
    cleanup();
    resetFakeTerminals();
    await flush();

    // Insensitive, but the variant has unsaved edits: its whole group stays.
    const dirty = createBackend(
      layoutWith([
        [D1, "a.txt"],
        [D2, "A.txt"],
      ]),
    );
    addFiles(dirty, ["A.txt"]);
    let release: (value: PathSemantics) => void = () => undefined;
    useSemantics(
      dirty,
      () =>
        new Promise<PathSemantics>((resolve) => {
          release = resolve;
        }),
    );
    useIdentity(dirty, { current: { "a.txt|A.txt": "same" } });
    host = await mountWorkspace({ backend: dirty });
    await flush();
    await act(async () => {
      await host!.ctx().loadFile(D2);
    });
    await act(async () => {
      host!.ctx().editFile(D2, "edited");
    });
    await act(async () => {
      release(INSENSITIVE);
    });
    await flush();
    expect(paths(host)).toEqual(["A.txt", "a.txt"]);
    expect(host.ctx().fileBuffers[D2]?.content).toBe("edited");
    // The merge did run and ask the backend; the unsaved edits are what kept the group.
    expect(invokes("check_project_files_same_identity").length).toBeGreaterThan(
      0,
    );
  });

  it("opens two case variants at the same time into one document", async () => {
    const backend = createBackend();
    addFiles(backend, ["A.txt"]);
    useSemantics(backend, INSENSITIVE);
    useIdentity(backend, { current: { "a.txt|A.txt": "same" } });
    host = await mountWorkspace({ backend });

    await act(async () => {
      await Promise.all([
        host!.ctx().openProjectFile(DIRECTORY.id, DIRECTORY.path, "a.txt"),
        host!.ctx().openProjectFile(DIRECTORY.id, DIRECTORY.path, "A.txt"),
      ]);
    });
    await flush();

    expect(paths(host)).toEqual(["a.txt"]);
  });

  it("settles a variant opened before the semantics arrive onto one document", async () => {
    const backend = createBackend(layoutWith([[D1, "a.txt"]]));
    addFiles(backend, ["A.txt"]);
    let release: (value: PathSemantics) => void = () => undefined;
    useSemantics(
      backend,
      () =>
        new Promise<PathSemantics>((resolve) => {
          release = resolve;
        }),
    );
    useIdentity(backend, { current: { "a.txt|A.txt": "same" } });
    host = await mountWorkspace({ backend });
    await flush();

    // The user opens the other spelling while the probe is still running.
    let opening: Promise<void> = Promise.resolve();
    await act(async () => {
      opening = host!
        .ctx()
        .openProjectFile(DIRECTORY.id, DIRECTORY.path, "A.txt");
    });
    await flush();
    await act(async () => {
      release(INSENSITIVE);
      await opening;
    });
    await flush();

    expect(paths(host)).toEqual(["a.txt"]);
  });
});

describe("layout.case_duplicate on save", () => {
  const duplicate = (ids: string[]) => ({
    code: "layout.case_duplicate",
    message: "variants",
    params: { documentIds: ids },
  });

  async function mountWithTwoGroups(saveHandler: (call: number) => unknown) {
    const backend = createBackend(
      layoutWith([
        [D1, "a.txt"],
        [D2, "A.txt"],
        [D3, "b.txt"],
        [D4, "B.txt"],
      ]),
    );
    addFiles(backend, ["A.txt", "B.txt"]);
    useSemantics(backend, INSENSITIVE);
    // At hydrate neither group is confirmed; later the first one is.
    const answers = { current: {} as Record<string, FileIdentityComparison> };
    useIdentity(backend, answers);
    let calls = 0;
    let armed = false;
    backend.handlers.set("save_workspace_layout", (args: any) => {
      backend.saved.push({ revision: args.revision, layout: args.layout });
      // Saves before the scenario starts (hydrate) are accepted.
      if (!armed) return { saved: true, revision: args.revision };
      calls += 1;
      return saveHandler(calls);
    });
    host = await mountWorkspace({ backend });
    await flush();
    expect(paths(host)).toEqual(["A.txt", "B.txt", "a.txt", "b.txt"]);
    answers.current = { "a.txt|A.txt": "same" };
    armed = true;
    return { backend, calls: () => calls };
  }

  it("retries once and then degrades a single item on layout.case_duplicate", async () => {
    const { calls } = await mountWithTwoGroups(() => {
      throw duplicate([D1, D2, D3, D4]);
    });

    // Opening another file changes the layout and saves it.
    await open(host!, "c.txt");
    await flush(10);

    // Rejected, repaired by merging the confirmed group, rejected again, degraded: two calls.
    expect(calls()).toBe(2);
    // The group a/A was merged; the b/B group lost its later variant.
    expect(paths(host!)).toEqual(["a.txt", "b.txt", "c.txt"]);
    expect(toastSpy.warning).toHaveBeenCalledTimes(1);
    // Nothing is sent after the degrade; a regular change saves the repaired layout.
    await flush(10);
    expect(calls()).toBe(2);
  });

  it("does not degrade when the repaired layout is accepted on the retry", async () => {
    const { calls } = await mountWithTwoGroups((call) => {
      if (call === 1) throw duplicate([D1, D2]);
      return { saved: true, revision: call + 1 };
    });

    await open(host!, "c.txt");
    await flush(10);

    expect(calls()).toBe(2);
    expect(paths(host!)).toEqual(["B.txt", "b.txt", "c.txt", "a.txt"].sort());
    expect(toastSpy.warning).not.toHaveBeenCalled();
    expect(host!.errors).toEqual([]);
  });
});

describe("source", () => {
  const sources = import.meta.glob(
    [
      "../**/*.ts",
      "../**/*.tsx",
      "!../**/*.test.ts",
      "!../**/*.test.tsx",
      "!../test/**",
    ],
    { query: "?raw", import: "default", eager: true },
  ) as Record<string, string>;

  it("has no template-string document identity left in source", () => {
    const pattern = /\$\{[^}]*directoryId\}:\$\{[^}]*(relativePath|identity)/;
    // Reverse: the scan must see a violation, or it would pass vacuously.
    expect(
      pattern.test("`${document.directoryId}:${document.relativePath}`"),
    ).toBe(true);

    const hits = Object.entries(sources).flatMap(([path, source]) =>
      source
        .split("\n")
        .filter((line) => pattern.test(line))
        .map((line) => `${path}: ${line.trim()}`),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("/lib/pathKey.ts");
  });
});

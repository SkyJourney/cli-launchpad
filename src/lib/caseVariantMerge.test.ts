import { describe, expect, it } from "vitest";
import caseFile from "../../contracts/path-key/case-merge-cases.json";
import {
  applyCaseVariantMerge,
  findCaseVariantGroups,
  type CaseMergeGroup,
  type CaseMergeInput,
} from "./caseVariantMerge";
import { UNKNOWN_PATH_SEMANTICS, type PathSemantics } from "./pathKey";
import {
  listWorkspacePanes,
  type WorkspaceNode,
  type WorkspacePane,
} from "./ptyWorkspaceLayout";
import type { FileIdentityComparison, WorkspacePaneContentRef } from "./tauri";

interface ScenarioPane {
  id: string;
  contents: string[];
  active: string | null;
}
interface Scenario {
  name: string;
  semantics: Record<string, PathSemantics>;
  documents: Array<{ id: string; directoryId: number; relativePath: string }>;
  panes: ScenarioPane[];
  detached: string[];
  fileIdentity: Record<string, FileIdentityComparison>;
  expected: {
    documents: string[];
    panes: ScenarioPane[];
    detached: string[];
    merged: Array<{ canonical: string; variants: string[] }>;
  };
}

const scenarios = caseFile.cases as unknown as Scenario[];

const file = (documentId: string): WorkspacePaneContentRef => ({
  kind: "file",
  documentId,
});

/** The scenario's flat pane list as a real layout tree (first before second). */
function inputOf(scenario: Scenario): CaseMergeInput {
  let tree: WorkspaceNode | null = null;
  scenario.panes.forEach((pane, index) => {
    const node: WorkspacePane = {
      kind: "pane",
      id: pane.id,
      paneNumber: index + 1,
      contents: pane.contents.map(file),
      activeContent: pane.active === null ? null : file(pane.active),
    };
    tree =
      tree === null
        ? node
        : {
            kind: "split",
            id: `split-${index}`,
            direction: "horizontal",
            ratio: 0.5,
            first: tree,
            second: node,
          };
  });
  return {
    tree: tree as unknown as WorkspaceNode,
    documents: scenario.documents.map((document) => ({
      id: document.id,
      directoryId: document.directoryId,
      directoryPath: `/work/dir${document.directoryId}`,
      relativePath: document.relativePath,
    })),
    detachedContents: scenario.detached.map(file),
  };
}

const idOf = (content: WorkspacePaneContentRef | null | undefined) =>
  content?.kind === "file" ? content.documentId : null;

/** What the host does: keep a variant unless the backend says it is another file. */
function confirmedGroups(
  scenario: Scenario,
  input: CaseMergeInput,
  groups: CaseMergeGroup[],
): CaseMergeGroup[] {
  const pathOf = (id: string) =>
    input.documents.find((document) => document.id === id)!.relativePath;
  return groups
    .map((group) => ({
      ...group,
      variantIds: group.variantIds.filter(
        (variantId) =>
          (scenario.fileIdentity[
            `${pathOf(group.canonicalId)}|${pathOf(variantId)}`
          ] ?? "unavailable") !== "different",
      ),
    }))
    .filter((group) => group.variantIds.length > 0);
}

describe("case variant merge", () => {
  it("has the nine required scenarios", () => {
    const names = scenarios.map((scenario) => scenario.name);
    for (const required of [
      "insensitive-same-identity-merges-into-first-seen",
      "insensitive-different-identity-does-not-merge",
      "insensitive-unavailable-identity-merges-by-flag",
      "unknown-never-merges",
      "sensitive-never-merges",
      "canonical-is-the-first-seen-in-tree-order",
      "rewrites-references-and-keeps-the-first-pane",
      "detached-contents-are-merged-the-same-way",
      "documents-in-different-directories-are-never-merged",
    ]) {
      expect(names).toContain(required);
    }
  });

  it.each(scenarios.map((scenario) => [scenario.name, scenario] as const))(
    "merges per the shared case %s",
    (_name, scenario) => {
      const input = inputOf(scenario);
      const semanticsOf = (directoryId: number) =>
        scenario.semantics[String(directoryId)] ?? UNKNOWN_PATH_SEMANTICS;
      const groups = confirmedGroups(
        scenario,
        input,
        findCaseVariantGroups(input, semanticsOf),
      );
      const result = applyCaseVariantMerge(input, groups, new Set());

      expect(result.documents.map((document) => document.id)).toEqual(
        scenario.expected.documents,
      );
      expect(
        listWorkspacePanes(result.tree).map((pane) => ({
          id: pane.id,
          contents: pane.contents.map(idOf),
          active: idOf(pane.activeContent),
        })),
      ).toEqual(scenario.expected.panes);
      expect(result.detachedContents.map(idOf)).toEqual(
        scenario.expected.detached,
      );
      expect(
        result.merged.map((group) => ({
          canonical: group.canonicalId,
          variants: group.variantIds,
        })),
      ).toEqual(scenario.expected.merged);
      // Reverse: no merged variant survives anywhere.
      for (const group of result.merged) {
        for (const variantId of group.variantIds) {
          expect(result.documents.some((d) => d.id === variantId)).toBe(false);
          expect(
            listWorkspacePanes(result.tree).some((pane) =>
              pane.contents.some((content) => idOf(content) === variantId),
            ),
          ).toBe(false);
        }
      }
    },
  );

  it("returns the same objects when nothing is merged", () => {
    const scenario = scenarios.find(
      (item) => item.name === "unknown-never-merges",
    )!;
    const input = inputOf(scenario);
    const groups = findCaseVariantGroups(input, () => UNKNOWN_PATH_SEMANTICS);
    expect(groups).toEqual([]);
    const result = applyCaseVariantMerge(input, groups, new Set());
    expect(Object.is(result.tree, input.tree)).toBe(true);
    expect(Object.is(result.documents, input.documents)).toBe(true);
    expect(Object.is(result.detachedContents, input.detachedContents)).toBe(
      true,
    );
    expect(result.merged).toEqual([]);
  });

  it("skips a whole group when a variant is in skipVariantIds", () => {
    const scenario = scenarios.find(
      (item) =>
        item.name === "insensitive-same-identity-merges-into-first-seen",
    )!;
    const input = inputOf(scenario);
    const semanticsOf = () => scenario.semantics["1"];
    const groups = findCaseVariantGroups(input, semanticsOf);
    expect(groups).toHaveLength(1);
    const result = applyCaseVariantMerge(input, groups, new Set(["d2"]));
    expect(Object.is(result.tree, input.tree)).toBe(true);
    expect(result.documents).toEqual(input.documents);
    expect(result.detachedContents).toEqual(input.detachedContents);
    expect(result.merged).toEqual([]);
  });
});

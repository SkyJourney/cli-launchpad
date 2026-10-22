import { describe, expect, it } from "vitest";
import contentKinds from "../../contracts/content-kinds.json";
import type { WorkspaceContentHandoffCapabilitiesByKind } from "../components/workspaceContentAdapterRegistry";
import {
  REGISTERED_CONTENT_KINDS,
  type RegisteredContentKind,
} from "../generated/contentKinds";
import type { WorkspaceContentHandoffPayloadByKind } from "./workspaceContentLifecycle";
import { isExcludedFromClosure, projectSources } from "../test/sourceClosure";
import type { WorkspacePaneContentRef } from "./tauri";
import { registeredContentKinds } from "./windowKinds";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
const assertTrue = <T extends true>(): T | undefined => undefined;

// 编译期：派生类型必须等于 DTO 联合去掉 "unknown"，且两个按 kind 分键的映射键集合等于它。
assertTrue<
  Equal<
    RegisteredContentKind,
    Exclude<WorkspacePaneContentRef["kind"], "unknown">
  >
>();
assertTrue<
  Equal<keyof WorkspaceContentHandoffCapabilitiesByKind, RegisteredContentKind>
>();
assertTrue<
  Equal<keyof WorkspaceContentHandoffPayloadByKind, RegisteredContentKind>
>();

const UNION_COPY =
  /["']pty["']\s*\|\s*["']file["']|["']file["']\s*\|\s*["']pty["']/;
const ARRAY_COPY = /\[\s*["']pty["']\s*,\s*["']file["']\s*\]/;

describe("content kind derivation", () => {
  it("generated content kinds equal the contract file and the window registry", () => {
    const fromContract = (contentKinds.items as { id: string }[]).map(
      (item) => item.id,
    );
    expect(REGISTERED_CONTENT_KINDS.length).toBeGreaterThan(0);
    expect([...REGISTERED_CONTENT_KINDS]).toEqual(fromContract);
    expect([...registeredContentKinds()]).toEqual(fromContract);
  });

  it("declares the content kind union in one place", () => {
    expect(UNION_COPY.test('type K = "pty" | "file";')).toBe(true);
    expect(ARRAY_COPY.test('const k = ["pty", "file"];')).toBe(true);

    const sources = Object.entries(projectSources).filter(
      ([path]) =>
        !isExcludedFromClosure(path) && !path.startsWith("src/generated/"),
    );
    expect(sources.length).toBeGreaterThan(50);
    const copies = sources
      .filter(
        ([, source]) => UNION_COPY.test(source) || ARRAY_COPY.test(source),
      )
      .map(([path]) => path);
    expect(
      copies,
      "内容 kind 联合与数组必须来自 src/generated/contentKinds.ts",
    ).toEqual([]);
  });
});

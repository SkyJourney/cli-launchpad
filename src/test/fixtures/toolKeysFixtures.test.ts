import { describe, expect, it } from "vitest";
import productContract from "../../../contracts/tool-keys.json";
import fixtureManifest from "./tool-keys.json";
// 在测试中，generated/toolKeys 经别名指向测试构建变体（产品清单加夹具）。
import { REGISTERED_TOOL_KEYS as testBuildKeys } from "../../generated/toolKeys";

// 直接读取产品生成文件的源码（glob 路径不经过测试别名），用于证明产品构建的清单不含夹具。
const productSourceFiles = import.meta.glob("../../generated/toolKeys.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function productGeneratedKeys(): string[] {
  const source = Object.values(productSourceFiles)[0];
  const body = source.slice(source.indexOf("= ["), source.indexOf("] as const"));
  return [...body.matchAll(/"([a-z][a-z0-9]*)"/g)].map((match) => match[1]);
}

describe("test-build tool key fixtures", () => {
  it("keeps the product generated list equal to the product contract", () => {
    expect(productGeneratedKeys()).toEqual(productContract.items);
  });

  it("merges fixtures into the test-build variant after the product list", () => {
    expect([...testBuildKeys]).toEqual([
      ...productContract.items,
      ...fixtureManifest.items,
    ]);
  });

  it("keeps fixtures disjoint from the product list", () => {
    for (const fixture of fixtureManifest.items) {
      expect(productContract.items, fixture).not.toContain(fixture);
    }
  });

  it("never writes a fixture into the product generated list", () => {
    const product = productGeneratedKeys();
    for (const fixture of fixtureManifest.items) {
      expect(product, fixture).not.toContain(fixture);
    }
  });
});

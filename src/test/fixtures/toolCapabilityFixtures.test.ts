import { describe, expect, it } from "vitest";
import productContract from "../../../contracts/tool-capabilities.json";
import fixtureManifest from "./tool-capabilities.json";
// 在测试中，generated/toolCapabilities 经别名指向测试构建变体（产品条目加夹具条目）。
import { TOOL_CAPABILITY_ITEMS as testBuildItems } from "../../generated/toolCapabilities";

// 产品生成文件的源码（glob 路径不经过测试别名），其中的数组即产品能力条目（JSON 字面量）。
const productSourceFiles = import.meta.glob("../../generated/toolCapabilities.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function productGeneratedItems(): unknown[] {
  const source = Object.values(productSourceFiles)[0];
  const body = source.slice(source.indexOf("= [") + 2, source.lastIndexOf(" as const;"));
  return JSON.parse(body) as unknown[];
}

describe("test-build tool capability fixtures", () => {
  it("keeps the product generated capability list equal to the product contract", () => {
    expect(productGeneratedItems()).toEqual(productContract.items);
  });

  it("adds fixture capability entries to the test-build list after the product entries", () => {
    expect(testBuildItems).toEqual([...productContract.items, ...fixtureManifest.items]);
  });

  it("never writes a fixture capability entry into the product generated list", () => {
    const product = productGeneratedItems() as Array<{ toolKey: string }>;
    for (const fixture of fixtureManifest.items as Array<{ toolKey: string }>) {
      expect(product.map((item) => item.toolKey), fixture.toolKey).not.toContain(fixture.toolKey);
    }
  });
});

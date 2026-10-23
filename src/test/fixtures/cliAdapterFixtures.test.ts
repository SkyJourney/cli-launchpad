import { describe, expect, it } from "vitest";
import productContract from "../../../contracts/tool-keys.json";
import fixtureManifest from "./tool-keys.json";
// 在测试中，generated/cliAdapters 经别名指向测试构建变体（产品适配器加夹具适配器）。
import { CLI_ADAPTERS_BY_KEY as testBuildAdapters } from "../../generated/cliAdapters";

// 产品生成文件的源码（glob 路径不经过测试别名）。
const productSourceFiles = import.meta.glob("../../generated/cliAdapters.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function productAdapterKeys(): string[] {
  const source = Object.values(productSourceFiles)[0];
  const body = source.slice(
    source.indexOf("CLI_ADAPTERS_BY_KEY"),
    source.lastIndexOf("};"),
  );
  return [...body.matchAll(/^\s+([a-z][a-z0-9]*): [a-z][a-zA-Z0-9]*Adapter,$/gm)].map(
    (match) => match[1],
  );
}

describe("test-build CLI adapter fixtures", () => {
  it("keeps the product adapter manifest equal to the product contract", () => {
    expect(productAdapterKeys()).toEqual(productContract.items);
  });

  it("adds fixture adapters to the test-build manifest after the product adapters", () => {
    expect(Object.keys(testBuildAdapters)).toEqual([
      ...productContract.items,
      ...fixtureManifest.items,
    ]);
  });

  it("never lists a fixture adapter in the product manifest", () => {
    const product = productAdapterKeys();
    for (const fixture of fixtureManifest.items) {
      expect(product, fixture).not.toContain(fixture);
    }
  });
});

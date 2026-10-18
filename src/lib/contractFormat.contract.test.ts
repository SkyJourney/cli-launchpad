import { describe, expect, it } from "vitest";

const files = import.meta.glob("../../contracts/*.json", {
  eager: true,
  import: "default",
}) as Record<string, Record<string, unknown>>;

/** 清单：必须是 { formatVersion, items }，顶层额外键只允许下表登记的名字。 */
const MANIFESTS: Record<string, readonly string[]> = {
  "api-versions.json": [],
  "app-commands.json": [],
  "content-kinds.json": [],
  "error-codes.json": ["frontendCodes", "reservedCodes", "aliases"],
  "events.json": [],
  "tool-capabilities.json": [],
  "tool-keys.json": [],
  "window-chrome.json": [],
  "window-kinds.json": [],
  "window-messages.json": [],
};

/** 豁免：不是契约清单；每项写明理由，新增文件必须在这里或上面登记。 */
const EXEMPT: Record<string, string> = {
  "rust-platform-tests.json":
    "CI 测试清单，格式由 scripts/ci/assert-rust-test-inventory.mjs 消费（m6-004）",
  "serde-lint-allowlist.json":
    "serde lint 的例外清单，格式由 Rust 测试消费（m6-015）",
  "window-label-fixtures.json":
    "窗口 label 的共用测试向量（m6-009），不是契约清单",
};

const nameOf = (path: string) => path.split("/").pop() as string;

describe("contract manifest format", () => {
  it("uses the common { formatVersion, items } envelope for every manifest", () => {
    for (const [path, value] of Object.entries(files)) {
      const name = nameOf(path);
      if (name in EXEMPT) continue;
      const allowed = MANIFESTS[name];
      expect(
        allowed,
        `${name} 没有在 MANIFESTS 或 EXEMPT 里登记`,
      ).toBeDefined();
      expect(Array.isArray(value), `${name} 不能是裸数组`).toBe(false);
      expect(
        Number.isInteger(value.formatVersion) &&
          (value.formatVersion as number) >= 1,
        name,
      ).toBe(true);
      expect(Array.isArray(value.items), `${name} 的 items 必须是数组`).toBe(
        true,
      );
      const extra = Object.keys(value)
        .filter((key) => key !== "formatVersion" && key !== "items")
        .sort();
      expect(extra, `${name} 的额外顶层键`).toEqual([...allowed].sort());
    }
  });

  it("classifies every contract file exactly once and keeps the tables honest", () => {
    const names = Object.keys(files).map(nameOf).sort();
    const classified = [
      ...Object.keys(MANIFESTS),
      ...Object.keys(EXEMPT),
    ].sort();

    expect(names).toEqual(classified);
    expect(Object.keys(MANIFESTS).some((name) => name in EXEMPT)).toBe(false);
    for (const reason of Object.values(EXEMPT)) {
      expect(reason.length).toBeGreaterThan(10);
    }
  });
});

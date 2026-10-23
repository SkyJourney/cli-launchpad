import { describe, expect, it } from "vitest";
import packageJson from "../../package.json";
import tauriConfig from "../../src-tauri/tauri.conf.json";

const tsSources = import.meta.glob("../**/*.{ts,tsx}", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;
const rsSources = import.meta.glob("../../src-tauri/src/**/*.rs", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;
const docs = import.meta.glob("../../docs/architecture.md", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;
const cargoFiles = import.meta.glob("../../src-tauri/Cargo.toml", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;
const contractFiles = import.meta.glob("../../contracts/*.json", {
  eager: true,
  import: "default",
}) as Record<
  string,
  { formatVersion: number; items: Array<{ id?: string; version?: number }> }
>;
const migrationFiles = Object.keys(
  import.meta.glob("../../src-tauri/migrations/*.sql"),
);

/**
 * glob 的键相对本文件所在目录 src/lib；统一换算成仓库相对路径。
 * 与文档的偏差：同目录文件的键以 "./" 开头（文档的写法会把它们截成 "src/xtensionApiVersions.ts"）。
 */
const repoPath = (key: string) =>
  key.startsWith("../../")
    ? key.slice(6)
    : key.startsWith("../")
      ? `src/${key.slice(3)}`
      : `src/lib/${key.slice(2)}`;
const byPath = (files: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(files).map(([key, value]) => [repoPath(key), value]),
  );

const tsByPath = byPath(tsSources) as Record<string, string>;
const rsByPath = byPath(rsSources) as Record<string, string>;
const contractsByPath = byPath(contractFiles) as typeof contractFiles;

const doc = Object.values(docs)[0];
const START = "<!-- version-registry:start -->";
const END = "<!-- version-registry:end -->";

interface Row {
  name: string;
  category: string;
  value: string;
  source: string;
}

function registryRows(): Row[] {
  const start = doc.indexOf(START);
  const end = doc.indexOf(END);
  expect(start, "缺少登记表起始标记").toBeGreaterThanOrEqual(0);
  expect(end, "缺少登记表结束标记").toBeGreaterThan(start);
  return doc
    .slice(start + START.length, end)
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.startsWith("|") && !/^\|\s*-/.test(line) && !line.includes("名字"),
    )
    .map((line) => {
      const cells = line.split("|").map((cell) => cell.trim());
      return {
        name: cells[1],
        category: cells[2],
        value: cells[3],
        source: cells[4].replace(/^`|`$/g, ""),
      };
    });
}

const isProductionTs = (file: string) =>
  !file.includes(".test.") &&
  !file.includes("/test/") &&
  !file.includes("/generated/");

const tsConstant = (name: string) =>
  new RegExp(`\\b${name}\\s*(?::[^=\\n]+)?=\\s*(\\d+)`);
const rsConstant = (name: string) =>
  new RegExp(`\\bconst\\s+${name}\\s*:\\s*[a-z0-9]+\\s*=\\s*(\\d+)\\s*;`);

function valueOf(row: Row): string {
  const [kind, ...rest] = row.source.split(":");
  const detail = rest.join(":");
  if (kind === "ts" || kind === "rs") {
    const separator = detail.lastIndexOf(":");
    const file = detail.slice(0, separator);
    const constant = detail.slice(separator + 1);
    const source = (kind === "ts" ? tsByPath : rsByPath)[file];
    expect(source, `${row.name}：找不到源文件 ${file}`).toBeDefined();
    const match = (
      kind === "ts" ? tsConstant(constant) : rsConstant(constant)
    ).exec(source);
    expect(
      match,
      `${row.name}：在 ${file} 里找不到 ${constant}`,
    ).not.toBeNull();
    return (match as RegExpExecArray)[1];
  }
  if (kind === "json") {
    const separator = detail.lastIndexOf(":");
    const file = detail.slice(0, separator);
    const key = detail.slice(separator + 1);
    const json = contractsByPath[file];
    expect(json, `${row.name}：找不到契约文件 ${file}`).toBeDefined();
    if (key === "formatVersion") return String(json.formatVersion);
    const item = json.items.find((candidate) => candidate.id === key);
    expect(item, `${row.name}：${file} 里没有 ${key}`).toBeDefined();
    return String((item as { version: number }).version);
  }
  if (kind === "prefix") {
    const separator = detail.indexOf(":");
    const file = detail.slice(0, separator);
    const text = detail.slice(separator + 1);
    const source = tsByPath[file];
    expect(source, `${row.name}：找不到源文件 ${file}`).toBeDefined();
    expect(source.includes(text), `${row.name}：${file} 不含 ${text}`).toBe(
      true,
    );
    return row.value;
  }
  if (kind === "migrations") {
    const numbers = migrationFiles
      .map((key) => /\/(\d+)_[^/]*\.sql$/.exec(key)?.[1])
      .filter((value): value is string => value !== undefined)
      .map(Number);
    expect(numbers.length).toBeGreaterThan(0);
    return String(Math.max(...numbers));
  }
  throw new Error(`${row.name}：未知来源写法 ${row.source}`);
}

describe("version registry", () => {
  it("registers every version constant found in the Rust and TypeScript sources", () => {
    const rows = registryRows();
    const registered = new Set(
      rows
        .filter(
          (row) => row.source.startsWith("ts:") || row.source.startsWith("rs:"),
        )
        .map((row) => row.source.slice(row.source.lastIndexOf(":") + 1)),
    );
    expect(rows.length).toBeGreaterThanOrEqual(14);

    const tsFiles = Object.keys(tsByPath).filter(isProductionTs);
    const rsFiles = Object.keys(rsByPath);
    expect(tsFiles.length).toBeGreaterThan(80);
    expect(rsFiles.length).toBeGreaterThan(50);

    const found: string[] = [];
    for (const file of tsFiles) {
      for (const match of tsByPath[file].matchAll(
        /\b([A-Z][A-Z0-9_]*_VERSION)\s*(?::[^=\n]+)?=\s*(\d+)/g,
      )) {
        found.push(`${file}:${match[1]}`);
        expect(
          registered.has(match[1]),
          `${file} 里的 ${match[1]} 没有登记`,
        ).toBe(true);
      }
    }
    for (const file of rsFiles) {
      const production = rsByPath[file].split("#[cfg(test)]")[0];
      for (const match of production.matchAll(
        /\bconst\s+([A-Z][A-Z0-9_]*VERSION[A-Z0-9_]*)\s*:\s*[a-z0-9]+\s*=\s*(\d+)\s*;/g,
      )) {
        found.push(`${file}:${match[1]}`);
        expect(
          registered.has(match[1]),
          `${file} 里的 ${match[1]} 没有登记`,
        ).toBe(true);
      }
    }
    expect(found.length).toBeGreaterThanOrEqual(5);
  });

  it("keeps every registry row equal to the value in its source", () => {
    for (const row of registryRows()) {
      if (row.source.startsWith("app:") || row.source.startsWith("same-as:"))
        continue;
      expect(valueOf(row), `${row.name}（${row.source}）`).toBe(row.value);
    }
  });

  it("keeps the application version identical in package.json, Cargo.toml and tauri.conf.json", () => {
    const cargo = /^version\s*=\s*"([^"]+)"/m.exec(
      Object.values(cargoFiles)[0],
    );

    expect(cargo?.[1]).toBe(packageJson.version);
    expect(tauriConfig.version).toBe(packageJson.version);
  });

  it("documents the rules R1 to R5 and the known exceptions", () => {
    for (const rule of ["R1", "R2", "R3", "R4", "R5"]) {
      expect(doc.includes(`**${rule} `), `缺少规则 ${rule}`).toBe(true);
    }
    expect(doc.includes("已知例外")).toBe(true);
    expect(doc.includes("protocolVersion")).toBe(true);
  });
});

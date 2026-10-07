/// <reference types="vite/client" />

export type SourceMap = Record<string, string>;

export interface ImportClosureOptions {
  /** 命中这些模块路径时停止遍历（既不收录，也不展开它们的导入）。 */
  stopAt?: readonly string[];
}

const ASSET_EXTENSIONS = [
  ".json",
  ".css",
  ".svg",
  ".png",
  ".webp",
  ".txt",
  ".woff",
  ".woff2",
  ".ttf",
];

const IMPORT_PATTERN =
  /\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\bimport\s+["']([^"']+)["']/g;

/** Vite 的 glob 键以 "/" 开头（相对项目根），统一成 "src/..." 形式。 */
export function normalizeGlobKey(key: string): string {
  return key.replace(/^\/+/, "");
}

function loadProjectSources(): SourceMap {
  const raw = import.meta.glob("/src/**/*.{ts,tsx}", {
    eager: true,
    query: "?raw",
    import: "default",
  }) as Record<string, string>;
  return Object.fromEntries(
    Object.entries(raw).map(([key, source]) => [normalizeGlobKey(key), source]),
  );
}

/** 项目全部 ts/tsx 源码，键为 "src/..."。 */
export const projectSources: SourceMap = loadProjectSources();

/** 测试文件与 src/test 下的模块不属于任何窗口的运行时闭包。 */
export function isExcludedFromClosure(path: string): boolean {
  return /\.test\.(ts|tsx)$/.test(path) || path.startsWith("src/test/");
}

export function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    specifiers.push(match[1] ?? match[2] ?? match[3]);
  }
  return specifiers;
}

function hasSource(sources: SourceMap, path: string): boolean {
  return Object.prototype.hasOwnProperty.call(sources, path);
}

export function resolveRelativeImport(
  from: string,
  specifier: string,
  sources: SourceMap,
): string | null {
  const bare = specifier.split("?")[0];
  const stack: string[] = [];
  for (const segment of [...from.split("/").slice(0, -1), ...bare.split("/")]) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") stack.pop();
    else stack.push(segment);
  }
  const base = stack.join("/");
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ]) {
    if (hasSource(sources, candidate)) return candidate;
  }
  return null;
}

function isAssetSpecifier(specifier: string): boolean {
  // Vite 的资源查询后缀（?raw、?url、?worker、?inline、?no-inline）是资源导入，
  // 例如 AboutView.tsx 的 "../../LICENSE?raw" 没有扩展名。
  if (/\?(?:raw|url|inline|no-inline|worker)\b/.test(specifier)) return true;
  return ASSET_EXTENSIONS.some((extension) => specifier.endsWith(extension));
}

/**
 * 计算入口出发的静态 import 闭包（返回排序后的模块路径）。
 * - 只跟随相对路径导入；包导入（react、@tauri-apps/...）不进入闭包。
 * - 资源导入（.json/.css/.svg/.png/.webp/.txt/字体，含 ?raw 查询）被忽略。
 * - 入口不存在，或相对代码导入无法解析时抛出 Error("unscanned source: ...")。
 * - 类型导入（import type）同样被跟随，闭包是运行时闭包的上界（只会多、不会少）。
 */
export function computeImportClosure(
  entries: readonly string[],
  sources: SourceMap,
  options: ImportClosureOptions = {},
): string[] {
  const stopAt = new Set(options.stopAt ?? []);
  for (const entry of entries) {
    if (!hasSource(sources, entry)) {
      throw new Error(`unscanned source: entry ${entry}`);
    }
  }
  const visited = new Set<string>();
  const pending = [...entries];
  while (pending.length > 0) {
    const path = pending.pop() as string;
    if (visited.has(path) || stopAt.has(path) || isExcludedFromClosure(path)) {
      continue;
    }
    visited.add(path);
    for (const specifier of importSpecifiers(sources[path])) {
      if (!specifier.startsWith(".")) continue;
      const resolved = resolveRelativeImport(path, specifier, sources);
      if (resolved !== null) {
        pending.push(resolved);
      } else if (!isAssetSpecifier(specifier)) {
        throw new Error(`unscanned source: ${path} imports ${specifier}`);
      }
    }
  }
  return [...visited].sort();
}

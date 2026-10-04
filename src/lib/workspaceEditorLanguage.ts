const extensionLanguages: Record<string, string> = {
  c: "cpp",
  cc: "cpp",
  cpp: "cpp",
  cs: "csharp",
  cxx: "cpp",
  dart: "dart",
  diff: "diff",
  dockerfile: "dockerfile",
  go: "go",
  h: "cpp",
  hpp: "cpp",
  htm: "html",
  html: "html",
  java: "java",
  js: "javascript",
  json: "json",
  jsonc: "jsonc",
  jsx: "javascript",
  md: "markdown",
  mjs: "javascript",
  mts: "typescript",
  ps1: "powershell",
  py: "python",
  rs: "rust",
  sh: "shell",
  sql: "sql",
  ts: "typescript",
  tsx: "typescript",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
};

export function resolveWorkspaceEditorLanguage(path: string): string {
  const segments = path.split(/[\\/]/);
  const basename = segments[segments.length - 1]?.toLowerCase() ?? "";
  if (basename === "dockerfile") return "dockerfile";
  if (basename === "makefile") return "shell";
  const nameParts = basename.split(".");
  const extension = nameParts[nameParts.length - 1] ?? "";
  return extensionLanguages[extension] ?? "plaintext";
}

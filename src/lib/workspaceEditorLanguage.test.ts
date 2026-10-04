import { describe, expect, it } from "vitest";
import { resolveWorkspaceEditorLanguage } from "./workspaceEditorLanguage";

describe("workspace editor language mapping", () => {
  it.each([
    ["src/App.TSX", "typescript"],
    ["scripts/start.sh", "shell"],
    ["Dockerfile", "dockerfile"],
    ["Makefile", "shell"],
    ["config.yml", "yaml"],
    ["src/main.rs", "rust"],
    ["notes.unknown", "plaintext"],
  ])("maps %s to %s", (path, language) => {
    expect(resolveWorkspaceEditorLanguage(path)).toBe(language);
  });
});

import { describe, expect, it } from "vitest";
import appCommands from "../../contracts/app-commands.json";
import { APP_COMMANDS } from "../generated/appCommands";

const raw = import.meta.glob(["./tauri.ts", "../generated/appCommands.ts"], {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;
const tauriSource = raw["./tauri.ts"];
const generatedSource = raw["../generated/appCommands.ts"];

const names = appCommands.items.map((item: string | { name: string }) =>
  typeof item === "string" ? item : item.name,
);

describe("generated AppCommand bindings", () => {
  it("lists exactly the commands in the contract, sorted", () => {
    expect([...APP_COMMANDS]).toEqual([...names].sort());
    expect(new Set(APP_COMMANDS).size).toBe(APP_COMMANDS.length);
    expect(APP_COMMANDS.length).toBeGreaterThanOrEqual(68);
  });

  it("matches the rendering of the contract byte for byte", () => {
    // 与 scripts/gen-contracts.mjs 的输出格式逐字一致；CI 另外真正运行生成器并 git diff。
    const expected = [
      "// 由 scripts/gen-contracts.mjs 生成，请勿手改。来源：contracts/app-commands.json",
      "export const APP_COMMANDS = [",
      ...[...names].sort().map((name) => `  "${name}",`),
      "] as const;",
      "",
      "export type AppCommand = (typeof APP_COMMANDS)[number];",
      "",
    ].join("\n");

    expect(generatedSource.replace(/\r\n/g, "\n")).toBe(expected);
  });

  it("keeps raw invoke out of tauri.ts", () => {
    expect(tauriSource).not.toMatch(/\binvoke\s*[<(]/);
    expect(tauriSource).toMatch(/import \{ invokeApp \} from "\.\/invokeApp"/);
  });

  it("references only registered commands through invokeApp in tauri.ts", () => {
    const used = [
      ...tauriSource.matchAll(/invokeApp(?:<[^>]*>)?\(\s*"(\w+)"/g),
    ].map((match) => match[1]);
    expect(used.length).toBeGreaterThanOrEqual(60);
    for (const name of used)
      expect(APP_COMMANDS as readonly string[], name).toContain(name);
  });
});

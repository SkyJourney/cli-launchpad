import { describe, expect, it } from "vitest";
import commandArgs from "../../contracts/derived/command-args.json";
import { isExcludedFromClosure, projectSources } from "../test/sourceClosure";
import {
  checkInvokeCall,
  collectInvokeCalls,
  type CommandArgContract,
} from "../test/invokeCalls";

const contract = commandArgs.items as CommandArgContract[];

describe("invokeApp argument keys", () => {
  it("collects literal and shorthand argument keys", () => {
    const calls = collectInvokeCalls(
      "src/x.ts",
      'const id = 1;\ninvokeApp<void>("a_cmd", { id, name: "x", "quoted": 1 });\ninvokeApp<void>("b_cmd");\n',
    );
    expect(calls).toEqual([
      {
        file: "src/x.ts",
        line: 2,
        command: "a_cmd",
        keys: ["id", "name", "quoted"],
      },
      { file: "src/x.ts", line: 3, command: "b_cmd", keys: [] },
    ]);
  });

  it("rejects spread arguments and non-literal command names", () => {
    for (const source of [
      'invokeApp("a", { ...rest });',
      "invokeApp(name);",
      'invokeApp("a", args);',
    ]) {
      expect(() => collectInvokeCalls("src/x.ts", source), source).toThrow(
        /invokeApp/,
      );
    }
    expect(() =>
      collectInvokeCalls("src/x.ts", 'invokeApp("a", { id });'),
    ).not.toThrow();
  });

  it("flags unknown and missing argument keys", () => {
    const sample: CommandArgContract[] = [
      {
        name: "add_directory",
        args: [
          { key: "name", optional: false },
          { key: "path", optional: false },
          { key: "note", optional: true },
        ],
      },
    ];
    const call = (keys: string[], command = "add_directory") => ({
      file: "src/x.ts",
      line: 1,
      command,
      keys,
    });
    const typo = checkInvokeCall(call(["name", "pth"]), sample).join("\n");
    expect(typo).toContain("未声明的参数键 pth");
    expect(typo).toContain("缺少必填参数键 path");
    expect(checkInvokeCall(call(["name", "path"]), sample)).toEqual([]);
    expect(checkInvokeCall(call(["name", "path", "note"]), sample)).toEqual([]);
    expect(checkInvokeCall(call([], "nope"), sample).join("\n")).toContain(
      "未登记的命令",
    );
  });

  it("every invokeApp call uses exactly the argument keys declared by the Rust command", () => {
    const calls = Object.entries(projectSources)
      .filter(
        ([path]) =>
          !isExcludedFromClosure(path) && !path.startsWith("src/generated/"),
      )
      .flatMap(([path, source]) => collectInvokeCalls(path, source));

    expect(calls.length).toBeGreaterThanOrEqual(50);
    const problems = calls.flatMap((call) => checkInvokeCall(call, contract));
    expect(problems, problems.join("\n")).toEqual([]);

    const used = new Set(calls.map((call) => call.command));
    const dangling = contract
      .map((item) => item.name)
      .filter((name) => !used.has(name));
    expect(dangling, "契约里没有调用点的命令").toEqual([]);
  });
});

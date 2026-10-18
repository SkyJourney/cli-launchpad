import fs from "node:fs";

const CHECK = process.argv.includes("--check");
const contract = JSON.parse(
  fs.readFileSync("contracts/app-commands.json", "utf8"),
);
const names = contract.items.map((item) =>
  typeof item === "string" ? item : item.name,
);
if (
  names.some(
    (name) => typeof name !== "string" || !/^[a-z][a-z0-9_]*$/.test(name),
  )
) {
  throw new Error("contracts/app-commands.json 含非法命令名");
}
if (new Set(names).size !== names.length) {
  throw new Error("contracts/app-commands.json 含重复命令名");
}
const sorted = [...names].sort();
const output = [
  "// 由 scripts/gen-contracts.mjs 生成，请勿手改。来源：contracts/app-commands.json",
  "export const APP_COMMANDS = [",
  ...sorted.map((name) => `  "${name}",`),
  "] as const;",
  "",
  "export type AppCommand = (typeof APP_COMMANDS)[number];",
  "",
].join("\n");

const target = "src/generated/appCommands.ts";
if (CHECK) {
  const current = fs.existsSync(target)
    ? fs.readFileSync(target, "utf8").replace(/\r\n/g, "\n")
    : "";
  if (current !== output) {
    console.error(
      `${target} 与契约不一致：运行 node scripts/gen-contracts.mjs`,
    );
    process.exit(1);
  }
  console.log(`${target} 与契约一致（${sorted.length} 个命令）`);
} else {
  fs.mkdirSync("src/generated", { recursive: true });
  fs.writeFileSync(target, output);
  console.log(`已生成 ${target}（${sorted.length} 个命令）`);
}

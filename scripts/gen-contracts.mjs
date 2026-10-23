import fs from "node:fs";

const CHECK = process.argv.includes("--check");

const commands = JSON.parse(
  fs.readFileSync("contracts/app-commands.json", "utf8"),
);
const names = commands.items.map((item) =>
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
const sortedNames = [...names].sort();

const contentKinds = JSON.parse(
  fs.readFileSync("contracts/content-kinds.json", "utf8"),
);
const kindIds = contentKinds.items.map((item) => item.id);
if (
  kindIds.length === 0 ||
  kindIds.some(
    (id) => typeof id !== "string" || !/^[a-z][A-Za-z0-9]*$/.test(id),
  )
) {
  throw new Error("contracts/content-kinds.json 含非法内容 kind");
}
if (new Set(kindIds).size !== kindIds.length) {
  throw new Error("contracts/content-kinds.json 含重复内容 kind");
}
if (
  contentKinds.items.some(
    (item) =>
      typeof item.idField !== "string" || !/^[a-z][A-Za-z0-9]*$/.test(item.idField),
  )
) {
  throw new Error("contracts/content-kinds.json 含非法 idField");
}

const toolKeys = JSON.parse(fs.readFileSync("contracts/tool-keys.json", "utf8"));
const toolKeyIds = toolKeys.items;
if (
  toolKeyIds.length === 0 ||
  toolKeyIds.some((id) => typeof id !== "string" || !/^[a-z][a-z0-9]*$/.test(id))
) {
  throw new Error("contracts/tool-keys.json 含非法工具键");
}
if (new Set(toolKeyIds).size !== toolKeyIds.length) {
  throw new Error("contracts/tool-keys.json 含重复工具键");
}

const toolKeyFixtures = JSON.parse(
  fs.readFileSync("src/test/fixtures/tool-keys.json", "utf8"),
).items;
if (
  toolKeyFixtures.some(
    (id) => typeof id !== "string" || !/^[a-z][a-z0-9]*$/.test(id),
  )
) {
  throw new Error("src/test/fixtures/tool-keys.json 含非法夹具工具键");
}
if (toolKeyFixtures.some((id) => toolKeyIds.includes(id))) {
  throw new Error("测试夹具与产品清单重复");
}
if (new Set(toolKeyFixtures).size !== toolKeyFixtures.length) {
  throw new Error("src/test/fixtures/tool-keys.json 含重复夹具工具键");
}

const outputs = [
  {
    target: "src/generated/toolKeys.testbuild.ts",
    count: toolKeyIds.length + toolKeyFixtures.length,
    content: [
      "// 测试构建变体：产品清单加测试夹具。仅由 vitest 别名引用，产品构建不引用。",
      "// 由 scripts/gen-contracts.mjs 生成，请勿手改。来源：contracts/tool-keys.json 与 src/test/fixtures/tool-keys.json",
      "export const REGISTERED_TOOL_KEYS = [",
      ...[...toolKeyIds, ...toolKeyFixtures].map((id) => `  "${id}",`),
      "] as const;",
      "",
      "export type RegisteredToolKey = (typeof REGISTERED_TOOL_KEYS)[number];",
      "",
    ].join("\n"),
  },
  {
    target: "src/generated/toolKeys.ts",
    count: toolKeyIds.length,
    content: [
      "// 由 scripts/gen-contracts.mjs 生成，请勿手改。来源：contracts/tool-keys.json",
      "export const REGISTERED_TOOL_KEYS = [",
      ...toolKeyIds.map((id) => `  "${id}",`),
      "] as const;",
      "",
      "export type RegisteredToolKey = (typeof REGISTERED_TOOL_KEYS)[number];",
      "",
    ].join("\n"),
  },
  {
    target: "src/generated/appCommands.ts",
    count: sortedNames.length,
    content: [
      "// 由 scripts/gen-contracts.mjs 生成，请勿手改。来源：contracts/app-commands.json",
      "export const APP_COMMANDS = [",
      ...sortedNames.map((name) => `  "${name}",`),
      "] as const;",
      "",
      "export type AppCommand = (typeof APP_COMMANDS)[number];",
      "",
    ].join("\n"),
  },
  {
    target: "src/generated/contentKinds.ts",
    count: kindIds.length,
    content: [
      "// 由 scripts/gen-contracts.mjs 生成，请勿手改。来源：contracts/content-kinds.json",
      "export const REGISTERED_CONTENT_KINDS = [",
      ...kindIds.map((id) => `  "${id}",`),
      "] as const;",
      "",
      "export type RegisteredContentKind = (typeof REGISTERED_CONTENT_KINDS)[number];",
      "",
      "/** 每种内容引用里承载身份的字段名（JSON 布局中的字段）。 */",
      "export const CONTENT_KIND_ID_FIELD = {",
      ...contentKinds.items.map((item) => `  ${item.id}: "${item.idField}",`),
      "} as const satisfies Record<RegisteredContentKind, string>;",
      "",
      "/** 所有已登记内容的引用形状：`{ kind, <idField>: string }`，由契约派生。 */",
      "export type RegisteredContentRef = {",
      "  [Kind in RegisteredContentKind]: { kind: Kind } & Record<",
      "    (typeof CONTENT_KIND_ID_FIELD)[Kind],",
      "    string",
      "  >;",
      "}[RegisteredContentKind];",
      "",
    ].join("\n"),
  },
];

let failed = false;
for (const { target, content, count } of outputs) {
  if (CHECK) {
    const current = fs.existsSync(target)
      ? fs.readFileSync(target, "utf8").replace(/\r\n/g, "\n")
      : "";
    if (current !== content) {
      console.error(
        `${target} 与契约不一致：运行 node scripts/gen-contracts.mjs`,
      );
      failed = true;
    } else {
      console.log(`${target} 与契约一致（${count} 项）`);
    }
  } else {
    fs.mkdirSync("src/generated", { recursive: true });
    fs.writeFileSync(target, content);
    console.log(`已生成 ${target}（${count} 项）`);
  }
}
if (failed) process.exit(1);

import { readFileSync } from "node:fs";

const [platform, listedPath, executedPath] = process.argv.slice(2);
const manifest = JSON.parse(
  readFileSync("contracts/rust-platform-tests.json", "utf8"),
);
const lines = (path) =>
  readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
const listed = new Set(lines(listedPath));
const executed = new Map(lines(executedPath).map((line) => line.split(" ")));
const errors = [];

const floor = manifest.minimumPassed[platform];
if (floor === undefined) errors.push(`unknown platform ${platform}`);
const passed = [...executed.values()].filter(
  (status) => status === "ok",
).length;
if (floor !== undefined && passed < floor)
  errors.push(`${platform}: only ${passed} passed, floor ${floor}`);

const groups = [
  "all",
  platform,
  ...(platform === "Linux" || platform === "macOS" ? ["unix"] : []),
];
for (const name of groups.flatMap((group) => manifest.required[group] ?? [])) {
  if (!listed.has(name))
    errors.push(`required test not compiled on ${platform}: ${name}`);
  else if (executed.get(name) !== "ok")
    errors.push(
      `required test did not pass: ${name} (${executed.get(name) ?? "not executed"})`,
    );
}
for (const [name, status] of executed) {
  if (status === "ignored" && !manifest.allowedIgnored.includes(name))
    errors.push(`unexpected ignored: ${name}`);
}
for (const name of listed) {
  if (!executed.has(name)) errors.push(`listed but not executed: ${name}`);
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`${platform}: ${passed} passed / ${listed.size} listed`);

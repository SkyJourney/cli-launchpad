import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const FORBIDDEN_ELEMENTS = [
  "base",
  "object",
  "embed",
  "iframe",
  "form",
  "frame",
  "frameset",
  "applet",
];

function isLocalReference(url) {
  return !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) && !url.startsWith("//");
}

function attributeValue(attributes, name) {
  const match = new RegExp(
    `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
    "i",
  ).exec(attributes);
  return match ? (match[1] ?? match[2]) : null;
}

/** Returns the problems in an HTML document that would conflict with the production CSP. */
export function findCspIncompatibilities(html) {
  const problems = [];
  if (/<style[\s>]/i.test(html)) problems.push("inline <style> element");
  for (const match of html.matchAll(/<script\b([^>]*)>/gi)) {
    const src = attributeValue(match[1], "src");
    if (src === null) {
      problems.push("inline <script> without src");
    } else if (!isLocalReference(src)) {
      problems.push(`external script src ${src}`);
    }
  }
  for (const match of html.matchAll(/<link\b([^>]*)>/gi)) {
    const href = attributeValue(match[1], "href");
    if (href !== null && !isLocalReference(href)) {
      problems.push(`external link href ${href}`);
    }
  }
  if (/<[a-z][^>]*\son[a-z]+\s*=/i.test(html))
    problems.push("inline event handler attribute");
  if (/\b(?:href|src|action|formaction)\s*=\s*["']\s*javascript:/i.test(html)) {
    problems.push("javascript: URL");
  }
  for (const name of FORBIDDEN_ELEMENTS) {
    if (new RegExp(`<${name}\\b`, "i").test(html))
      problems.push(`forbidden <${name}> element`);
  }
  return [...new Set(problems)];
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error(
      "usage: node scripts/ci/assert-dist-html-csp.mjs <html-file>",
    );
    process.exit(2);
  }
  const problems = findCspIncompatibilities(readFileSync(file, "utf8"));
  if (problems.length > 0) {
    console.error(`dist html csp check failed: ${file}`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`dist html csp check passed: ${file}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}

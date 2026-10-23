import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findCspIncompatibilities } from "./assert-dist-html-csp.mjs";

const clean =
  '<!doctype html><html lang="en"><head><meta charset="UTF-8" /><title>x</title><script type="module" crossorigin src="/assets/index-abc.js"></script><link rel="modulepreload" crossorigin href="/assets/vendor-abc.js"><link rel="stylesheet" crossorigin href="/assets/index-abc.css"></head><body><div id="root"></div></body></html>';

describe("findCspIncompatibilities", () => {
  it("accepts the Vite production shape", () => {
    expect(findCspIncompatibilities(clean)).toEqual([]);
    // Reverse: a relative path without a leading slash is local too.
    expect(
      findCspIncompatibilities(
        clean.replace(
          'src="/assets/index-abc.js"',
          'src="assets/index-abc.js"',
        ),
      ),
    ).toEqual([]);
  });

  it("flags an inline style element", () => {
    expect(
      findCspIncompatibilities(
        "<html><head><style>body{margin:0}</style></head></html>",
      ),
    ).toEqual(["inline <style> element"]);
    expect(findCspIncompatibilities("<STYLE>body{margin:0}</STYLE>")).toEqual([
      "inline <style> element",
    ]);
    // Reverse: a stylesheet link is fine.
    expect(
      findCspIncompatibilities('<link rel="stylesheet" href="/a.css">'),
    ).toEqual([]);
  });

  it("flags inline scripts but not external module scripts", () => {
    expect(findCspIncompatibilities("<script>alert(1)</script>")).toEqual([
      "inline <script> without src",
    ]);
    expect(
      findCspIncompatibilities(
        '<script type="module" src="/assets/a.js"></script>',
      ),
    ).toEqual([]);
    expect(
      findCspIncompatibilities('<script type="application/json">{}</script>'),
    ).toEqual(["inline <script> without src"]);
    // Reverse: with both kinds present only the inline one is reported.
    expect(
      findCspIncompatibilities(
        '<script src="/assets/a.js"></script><script>1</script>',
      ),
    ).toEqual(["inline <script> without src"]);
  });

  it("flags inline event handler attributes", () => {
    for (const html of [
      '<body onload="x()">',
      '<div id="a" onclick="x()"></div>',
      "<img src=\"/a.png\" onerror='x()'>",
    ]) {
      expect(findCspIncompatibilities(html)).toEqual([
        "inline event handler attribute",
      ]);
    }
    // Reverse: attribute names that merely contain "on" are not handlers.
    expect(
      findCspIncompatibilities('<div data-online="1" id="once"></div>'),
    ).toEqual([]);
  });

  it("flags resources loaded from outside the app origin", () => {
    expect(
      findCspIncompatibilities(
        '<script src="https://cdn.example.com/x.js"></script>',
      ),
    ).toEqual(["external script src https://cdn.example.com/x.js"]);
    expect(
      findCspIncompatibilities(
        '<script src="//cdn.example.com/x.js"></script>',
      ),
    ).toEqual(["external script src //cdn.example.com/x.js"]);
    expect(
      findCspIncompatibilities(
        '<link rel="stylesheet" href="http://x.test/y.css">',
      ),
    ).toEqual(["external link href http://x.test/y.css"]);
    expect(
      findCspIncompatibilities(
        '<script src="data:text/javascript,1"></script>',
      ),
    ).toEqual(["external script src data:text/javascript,1"]);
    // Reverse: a local icon link is fine.
    expect(
      findCspIncompatibilities('<link rel="icon" href="/favicon.ico">'),
    ).toEqual([]);
  });

  it("flags javascript URLs", () => {
    expect(
      findCspIncompatibilities('<a href="javascript:alert(1)">x</a>'),
    ).toContain("javascript: URL");
    const frame = findCspIncompatibilities(
      "<iframe src='  javascript:alert(1)'></iframe>",
    );
    expect(frame).toContain("javascript: URL");
    expect(frame).toContain("forbidden <iframe> element");
    // Reverse: an ordinary local link is fine.
    expect(findCspIncompatibilities('<a href="/docs">x</a>')).toEqual([]);
  });

  it("flags forbidden elements", () => {
    const cases = [
      ['<base href="/">', "forbidden <base> element"],
      ['<object data="x"></object>', "forbidden <object> element"],
      ['<embed src="/x">', "forbidden <embed> element"],
      ["<iframe></iframe>", "forbidden <iframe> element"],
      ['<form action="/x"></form>', "forbidden <form> element"],
    ];
    for (const [html, problem] of cases) {
      expect(findCspIncompatibilities(html)).toContain(problem);
    }
    // Reverse: an element that merely starts with "base" is not <base>.
    expect(findCspIncompatibilities("<basefont>")).toEqual([]);
  });

  it("the repository index.html is clean", () => {
    const html = readFileSync(
      new URL("../../index.html", import.meta.url),
      "utf8",
    );
    expect(findCspIncompatibilities(html)).toEqual([]);
    // Reverse: the real file was read.
    expect(html).toContain("/src/main.tsx");
    expect(html.length).toBeGreaterThan(100);
  });

  it("the command line tool exits non-zero for an incompatible file", () => {
    const script = fileURLToPath(
      new URL("./assert-dist-html-csp.mjs", import.meta.url),
    );
    const directory = mkdtempSync(join(tmpdir(), "csp-html-"));
    try {
      const bad = join(directory, "bad.html");
      const good = join(directory, "good.html");
      writeFileSync(bad, "<html><head><style>a{}</style></head></html>");
      writeFileSync(good, clean);

      const failed = spawnSync(process.execPath, [script, bad], {
        encoding: "utf8",
      });
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain("inline <style> element");
      // Reverse: a clean file passes, and a missing argument is a usage error.
      const passed = spawnSync(process.execPath, [script, good], {
        encoding: "utf8",
      });
      expect(passed.status).toBe(0);
      expect(passed.stdout).toContain("dist html csp check passed");
      expect(
        spawnSync(process.execPath, [script], { encoding: "utf8" }).status,
      ).toBe(2);
    } finally {
      rmSync(directory, { recursive: true });
    }
  });
});

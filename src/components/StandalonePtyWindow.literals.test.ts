import ts from "typescript";
import { describe, expect, it } from "vitest";

const CJK = /[㐀-鿿＀-￯]/;

/**
 * Finds literals that would show user-facing text without going through i18n:
 * any string with CJK characters, `new Error("...")`, `?? "..."` fallbacks and
 * JSX text that contains letters.
 */
function scanUserFacingLiterals(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const found: string[] = [];
  const isLiteral = (node: ts.Node): node is ts.StringLiteralLike =>
    ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
  const visit = (node: ts.Node) => {
    if (isLiteral(node) && CJK.test(node.text)) {
      found.push(`CJK literal: ${node.text}`);
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Error" &&
      node.arguments?.length &&
      isLiteral(node.arguments[0])
    ) {
      found.push(`new Error literal: ${node.arguments[0].text}`);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
      isLiteral(node.right)
    ) {
      found.push(`?? literal: ${node.right.text}`);
    }
    if (ts.isJsxText(node) && /\p{L}/u.test(node.text)) {
      found.push(`JSX text: ${node.text.trim()}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const sources = import.meta.glob("./StandalonePtyWindow.tsx", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

describe("StandalonePtyWindow user-facing literals", () => {
  it("keeps hard-coded user-facing literals out of StandalonePtyWindow.tsx", () => {
    const entries = Object.entries(sources);

    expect(entries.map(([key]) => key)).toEqual(["./StandalonePtyWindow.tsx"]);
    expect(
      scanUserFacingLiterals("StandalonePtyWindow.tsx", entries[0][1]),
    ).toEqual([]);
  });

  it("reports every kind of hard-coded literal in a synthetic source and accepts i18n calls", () => {
    const bad = `
      export function Bad({ message }: { message?: string }) {
        const a = message ?? "Unknown error";
        const b = new Error("返回请求已过期");
        const c = "返回请求失败";
        return <p>Something went wrong</p>;
      }
    `;
    const good = `
      export function Good({ message }: { message?: string }) {
        const a = message ?? translate("pty.returnUnknownError");
        const b = new Error(translate("pty.returnExpired"));
        return <p className="status">{translate("pty.starting")}</p>;
      }
    `;

    const findings = scanUserFacingLiterals("Bad.tsx", bad);

    expect(findings).toEqual([
      "?? literal: Unknown error",
      "new Error literal: 返回请求已过期",
      "CJK literal: 返回请求已过期",
      "CJK literal: 返回请求失败",
      "JSX text: Something went wrong",
    ]);
    expect(scanUserFacingLiterals("Good.tsx", good)).toEqual([]);
  });
});

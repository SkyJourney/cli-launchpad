import ts from "typescript";

const EFFECT_HOOKS = new Set([
  "useEffect",
  "useLayoutEffect",
  "useInsertionEffect",
]);
const DERIVED_HOOKS = new Set(["useCallback", "useMemo"]);
const LANGUAGE_SYNC_MARKER = "R-FE-1:language-sync";

export interface EffectViolation {
  /** `<文件>::<所属函数>::<hook>#<序号>`，不含行号，行号漂移不会让存量登记失效。 */
  key: string;
  file: string;
  line: number;
  hook: string;
  problems: string[];
}

type FunctionLike =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration;

function isFunctionLike(node: ts.Node): node is FunctionLike {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

function bindingNames(name: ts.BindingName, out: string[] = []): string[] {
  if (ts.isIdentifier(name)) {
    out.push(name.text);
  } else {
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) bindingNames(element.name, out);
    }
  }
  return out;
}

function enclosingFunctions(node: ts.Node): FunctionLike[] {
  const chain: FunctionLike[] = [];
  for (let current = node.parent; current; current = current.parent) {
    if (isFunctionLike(current)) chain.push(current);
  }
  return chain;
}

/** `var` 声明会提升到所在函数（不含嵌套函数）：函数参数与整个函数体里的 `var` 都算该函数的名字。 */
function declaresInFunction(scope: FunctionLike, name: string): boolean {
  for (const parameter of scope.parameters) {
    if (bindingNames(parameter.name).includes(name)) return true;
  }
  const body = scope.body;
  if (!body || !ts.isBlock(body)) return false;
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (node !== body && isFunctionLike(node)) return;
    if (
      ts.isVariableDeclarationList(node) &&
      !(node.flags & ts.NodeFlags.BlockScoped) &&
      node.declarations.some((declaration) =>
        bindingNames(declaration.name).includes(name),
      )
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return found;
}

/** 块、for 头、catch 子句自己拥有的块级声明（let、const、class、函数声明）。 */
function declaresInBlockScope(node: ts.Node, name: string): boolean {
  const listDeclares = (list: ts.ForInitializer | undefined) =>
    !!list &&
    ts.isVariableDeclarationList(list) &&
    !!(list.flags & ts.NodeFlags.BlockScoped) &&
    list.declarations.some((declaration) =>
      bindingNames(declaration.name).includes(name),
    );
  if (ts.isBlock(node) || ts.isCaseBlock(node) || ts.isSourceFile(node)) {
    const statements = ts.isCaseBlock(node)
      ? node.clauses.flatMap((clause) => [...clause.statements])
      : [...node.statements];
    return statements.some(
      (statement) =>
        (ts.isVariableStatement(statement) &&
          listDeclares(statement.declarationList)) ||
        ((ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement)) &&
          statement.name?.text === name),
    );
  }
  if (
    ts.isForStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isForInStatement(node)
  ) {
    return listDeclares(node.initializer);
  }
  if (ts.isCatchClause(node)) {
    return (
      !!node.variableDeclaration &&
      bindingNames(node.variableDeclaration.name).includes(name)
    );
  }
  return false;
}

/**
 * 从标识符向上走到持有 `useTranslation()` 的函数为止，途中任何一层声明了同名绑定就算被遮蔽：
 * 内层函数的参数与 `var`、途中各块的块级声明、for 头与 catch 变量；持有函数自己的最外层函数体不算。
 */
function shadowedOnPath(
  identifier: ts.Identifier,
  owner: FunctionLike,
  name: string,
): boolean {
  for (
    let current: ts.Node | undefined = identifier.parent;
    current && current !== owner;
    current = current.parent
  ) {
    if (isFunctionLike(current) && declaresInFunction(current, name)) {
      return true;
    }
    if (current === owner.body) continue;
    if (declaresInBlockScope(current, name)) return true;
  }
  return false;
}

/** 该函数里（不含嵌套函数）由 `useTranslation()` 解构出的名字。 */
function translationBindings(scope: FunctionLike): Set<string> {
  const names = new Set<string>();
  const body = scope.body;
  if (!body || !ts.isBlock(body)) return names;
  const visit = (node: ts.Node) => {
    if (node !== body && isFunctionLike(node)) return;
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === "useTranslation"
    ) {
      for (const name of bindingNames(node.name)) names.add(name);
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return names;
}

function isTranslationReference(identifier: ts.Identifier): boolean {
  const name = identifier.text;
  const parent = identifier.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === identifier)
    return false;
  if (ts.isPropertyAssignment(parent) && parent.name === identifier)
    return false;
  if (ts.isBindingElement(parent) && parent.propertyName === identifier)
    return false;
  if (ts.isVariableDeclaration(parent) && parent.name === identifier)
    return false;
  if (ts.isParameter(parent) && parent.name === identifier) return false;
  const chain = enclosingFunctions(identifier);
  for (let index = 0; index < chain.length; index += 1) {
    if (translationBindings(chain[index]).has(name)) {
      return !shadowedOnPath(identifier, chain[index], name);
    }
  }
  return false;
}

function collectIdentifiers(
  node: ts.Node,
  predicate: (identifier: ts.Identifier) => boolean,
): ts.Identifier[] {
  const out: ts.Identifier[] = [];
  const visit = (current: ts.Node) => {
    if (ts.isIdentifier(current) && predicate(current)) out.push(current);
    ts.forEachChild(current, visit);
  };
  visit(node);
  return out;
}

function hookName(node: ts.Node): string | null {
  if (!ts.isCallExpression(node)) return null;
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

function ownerName(node: ts.Node): string {
  for (
    let current: ts.Node | undefined = node.parent;
    current;
    current = current.parent
  ) {
    if (
      (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current)) &&
      current.name
    ) {
      return current.name.text;
    }
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name))
      return current.name.text;
  }
  return "<module>";
}

interface HookCall {
  node: ts.CallExpression;
  name: string;
  scope: FunctionLike | undefined;
}

export function scanSource(fileName: string, text: string): EffectViolation[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const hookCalls: HookCall[] = [];
  const collect = (node: ts.Node) => {
    const name = hookName(node);
    if (name && (EFFECT_HOOKS.has(name) || DERIVED_HOOKS.has(name))) {
      hookCalls.push({
        node: node as ts.CallExpression,
        name,
        scope: enclosingFunctions(node)[0],
      });
    }
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);

  const derivedByVariable = new Map<string, HookCall>();
  for (const hook of hookCalls) {
    if (!DERIVED_HOOKS.has(hook.name)) continue;
    const parent = hook.node.parent;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
      derivedByVariable.set(
        `${hook.scope?.pos ?? -1}:${parent.name.text}`,
        hook,
      );
    }
  }

  const depsOf = (hook: HookCall): ts.ArrayLiteralExpression | null => {
    const argument = hook.node.arguments[1];
    return argument && ts.isArrayLiteralExpression(argument) ? argument : null;
  };
  const lineOf = (node: ts.Node) =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line +
    1;

  const isLanguageSync = (hook: HookCall): boolean => {
    const statement = hook.node.parent;
    const comments =
      ts.getLeadingCommentRanges(text, statement.getFullStart()) ?? [];
    if (
      !comments.some((range) =>
        text.slice(range.pos, range.end).includes(LANGUAGE_SYNC_MARKER),
      )
    ) {
      return false;
    }
    const deps = depsOf(hook);
    if (!deps) return false;
    const keyed = deps.elements.some(
      (element) =>
        ts.isPropertyAccessExpression(element) &&
        element.name.text === "resolvedLanguage",
    );
    const others = collectIdentifiers(deps, isTranslationReference).filter(
      (identifier) =>
        !(
          ts.isPropertyAccessExpression(identifier.parent) &&
          identifier.parent.expression === identifier &&
          identifier.parent.name.text === "resolvedLanguage"
        ),
    );
    return keyed && others.length === 0;
  };

  const violations: EffectViolation[] = [];
  const ordinals = new Map<string, number>();
  for (const hook of hookCalls) {
    if (!EFFECT_HOOKS.has(hook.name)) continue;
    const ordinalKey = `${ownerName(hook.node)}::${hook.name}`;
    const ordinal = (ordinals.get(ordinalKey) ?? 0) + 1;
    ordinals.set(ordinalKey, ordinal);
    if (isLanguageSync(hook)) continue;

    const problems: string[] = [];
    const visited = new Set<HookCall>();
    const inspect = (current: HookCall, via: string) => {
      const deps = depsOf(current);
      if (deps) {
        for (const identifier of collectIdentifiers(
          deps,
          isTranslationReference,
        )) {
          problems.push(
            `${via}: 依赖数组引用 ${identifier.text}（第 ${lineOf(identifier)} 行）`,
          );
        }
      }
      const callback = current.node.arguments[0];
      if (!callback) return;
      for (const identifier of collectIdentifiers(
        callback,
        isTranslationReference,
      )) {
        problems.push(
          `${via}: 回调引用 ${identifier.text}（第 ${lineOf(identifier)} 行）`,
        );
      }
      const names = new Set(
        collectIdentifiers(current.node, () => true).map(
          (identifier) => identifier.text,
        ),
      );
      for (const name of names) {
        const derived = derivedByVariable.get(
          `${current.scope?.pos ?? -1}:${name}`,
        );
        if (derived && !visited.has(derived)) {
          visited.add(derived);
          inspect(derived, `${via} → ${name}`);
        }
      }
    };
    inspect(hook, hook.name);
    if (problems.length > 0) {
      violations.push({
        key: `${fileName}::${ownerName(hook.node)}::${hook.name}#${ordinal}`,
        file: fileName,
        line: lineOf(hook.node),
        hook: hook.name,
        problems,
      });
    }
  }
  return violations;
}

/** sources 的键必须是以 `src/` 开头的仓库相对路径（正斜杠）。 */
export function scanSources(sources: Record<string, string>): {
  files: number;
  effects: number;
  violations: EffectViolation[];
} {
  const files = Object.keys(sources).sort();
  return {
    files: files.length,
    effects: files.reduce(
      (sum, file) =>
        sum +
        (sources[file].match(/\buse(?:Layout|Insertion)?Effect\(/g)?.length ??
          0),
      0,
    ),
    violations: files.flatMap((file) => scanSource(file, sources[file])),
  };
}

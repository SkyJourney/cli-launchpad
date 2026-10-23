import ts from "typescript";

export interface InvokeCall {
  file: string;
  line: number;
  command: string;
  keys: string[];
}

export interface CommandArgContract {
  name: string;
  args: { key: string; optional: boolean }[];
}

/** 静态收集源码里全部 invokeApp 调用的命令名与参数键；遇到无法静态判断的写法直接抛错。 */
export function collectInvokeCalls(file: string, source: string): InvokeCall[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const calls: InvokeCall[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "invokeApp"
    ) {
      const line =
        sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      const [commandArgument, argsArgument] = node.arguments;
      if (!commandArgument || !ts.isStringLiteralLike(commandArgument)) {
        throw new Error(`${file}:${line} invokeApp 的命令名必须是字符串字面量`);
      }
      const keys: string[] = [];
      if (argsArgument) {
        if (!ts.isObjectLiteralExpression(argsArgument)) {
          throw new Error(`${file}:${line} invokeApp 的参数必须是对象字面量`);
        }
        for (const property of argsArgument.properties) {
          if (ts.isShorthandPropertyAssignment(property)) {
            keys.push(property.name.text);
          } else if (
            ts.isPropertyAssignment(property) &&
            (ts.isIdentifier(property.name) ||
              ts.isStringLiteralLike(property.name))
          ) {
            keys.push(property.name.text);
          } else {
            throw new Error(
              `${file}:${line} invokeApp 的参数含不支持的写法（展开或计算键）`,
            );
          }
        }
      }
      calls.push({
        file,
        line,
        command: commandArgument.text,
        keys: keys.sort(),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return calls;
}

/** 返回问题清单；空数组表示该调用与契约一致。 */
export function checkInvokeCall(
  call: InvokeCall,
  contract: readonly CommandArgContract[],
): string[] {
  const entry = contract.find((item) => item.name === call.command);
  if (!entry) return [`${call.file}:${call.line} 未登记的命令 ${call.command}`];
  const declared = entry.args.map((arg) => arg.key);
  const problems: string[] = [];
  for (const key of call.keys) {
    if (!declared.includes(key)) {
      problems.push(
        `${call.file}:${call.line} ${call.command} 使用了未声明的参数键 ${key}`,
      );
    }
  }
  for (const arg of entry.args) {
    if (!arg.optional && !call.keys.includes(arg.key)) {
      problems.push(
        `${call.file}:${call.line} ${call.command} 缺少必填参数键 ${arg.key}`,
      );
    }
  }
  return problems;
}

/// Tokenize the argument syntax shared with Rust's launch service. Whitespace
/// separates tokens outside quotes; single/double quotes group values; inside
/// double quotes a backslash escapes the next character.
export function tokenizeArgs(args: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "single" | "double" | null = null;
  let hasToken = false;

  const characters = Array.from(args);
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (character === "\\" && quote === "double") {
      const next = characters[index + 1];
      if (next === "\\" || next === '"') {
        current += next;
        index += 1;
      } else {
        current += "\\";
      }
      hasToken = true;
      continue;
    }
    if (character === "'" && quote !== "double") {
      quote = quote === "single" ? null : "single";
      hasToken = true;
      continue;
    }
    if (character === '"' && quote !== "single") {
      quote = quote === "double" ? null : "double";
      hasToken = true;
      continue;
    }
    if (/\s/.test(character) && quote === null) {
      if (hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    current += character;
    hasToken = true;
  }

  if (hasToken) tokens.push(current);
  return tokens;
}

export function serializeArgs(tokens: string[]): string {
  return tokens.map(serializeToken).join(" ");
}

function serializeToken(token: string): string {
  if (token !== "" && !/[\s"']/.test(token)) return token;
  return `"${token.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/// Read the last occurrence of a flag, accepting both `--flag value` and
/// `--flag=value`, which matches common CLI last-value-wins behavior.
export function getFlagValue(args: string, flag: string): string | null {
  const tokens = tokenizeArgs(args);
  let found: string | null = null;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === flag) {
      const next = tokens[index + 1];
      if (next !== undefined && !next.startsWith("-")) {
        found = next;
        index += 1;
      }
    } else if (token.startsWith(`${flag}=`)) {
      found = token.slice(flag.length + 1);
    }
  }
  return found;
}

/// Remove every previous occurrence, then append one canonical flag/value pair.
/// Removing duplicates prevents stale model flags from competing at launch.
export function setFlagValue(
  args: string,
  flag: string,
  value: string | null,
): string {
  const tokens = tokenizeArgs(args);
  const kept: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === flag) {
      const next = tokens[index + 1];
      if (next !== undefined && !next.startsWith("-")) index += 1;
      continue;
    }
    if (token.startsWith(`${flag}=`)) continue;
    kept.push(token);
  }

  if (value != null) kept.push(flag, value);
  return serializeArgs(kept);
}

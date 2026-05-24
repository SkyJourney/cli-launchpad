/// Helpers for manipulating a single whitespace-separated argument string,
/// used by the parameter editor to drive the Claude model quick-select while
/// keeping the freeform arguments field as the single source of truth.

function tokenize(args: string): string[] {
  return args.split(/\s+/).filter(Boolean);
}

/// A flag has a value only if the next token exists and is not itself a flag.
function hasFollowingValue(tokens: string[], index: number): boolean {
  const next = tokens[index + 1];
  return next !== undefined && !next.startsWith("-");
}

/// Read the value following a flag (e.g. the model after `--model`).
export function getFlagValue(args: string, flag: string): string | null {
  const tokens = tokenize(args);
  const index = tokens.indexOf(flag);
  if (index >= 0 && hasFollowingValue(tokens, index)) {
    return tokens[index + 1];
  }
  return null;
}

/// Set, replace, or (when value is null) remove a flag and its value.
export function setFlagValue(
  args: string,
  flag: string,
  value: string | null,
): string {
  const tokens = tokenize(args);
  const index = tokens.indexOf(flag);

  if (index >= 0) {
    const hasValue = hasFollowingValue(tokens, index);
    if (value == null) {
      tokens.splice(index, hasValue ? 2 : 1);
    } else if (hasValue) {
      tokens[index + 1] = value;
    } else {
      tokens.splice(index + 1, 0, value);
    }
  } else if (value != null) {
    tokens.push(flag, value);
  }

  return tokens.join(" ");
}

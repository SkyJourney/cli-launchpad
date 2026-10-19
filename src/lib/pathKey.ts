// Path semantics of a project root and the one key function for project-relative paths (PD-10).
// The types mirror the Rust `PathSemantics` (camelCase, string tri-state); `pathKeyOf` mirrors
// `PathKey::of` and both read the vectors in `contracts/path-key/path-key-vectors.json`.
import { caseFoldMap } from "./caseFoldTable";

export type CaseSensitivity = "sensitive" | "insensitive" | "unknown";
export type Tri = "yes" | "no" | "unknown";
export type PathSemantics = {
  case: CaseSensitivity;
  normalizationInsensitive: Tri;
};

/** Nothing is known about the location: never fold, never normalize. */
export const UNKNOWN_PATH_SEMANTICS: PathSemantics = {
  case: "unknown",
  normalizationInsensitive: "unknown",
};

/** Full case folding, code point by code point (it has no context rules). */
function foldCase(text: string): string {
  const map = caseFoldMap();
  let folded = "";
  for (const character of text) {
    folded += map.get(character.codePointAt(0) as number) ?? character;
  }
  return folded;
}

/**
 * The comparison key of a project-relative path. `sensitive` and `unknown` never fold, the
 * normalization axis acts only on `yes`; separators and non-letters are kept as they are.
 * Equal keys only mean "candidates for the same file": merging also needs a file identity.
 */
export function pathKeyOf(
  relativePath: string,
  semantics: PathSemantics,
): string {
  const fold = semantics.case === "insensitive";
  const normalize = semantics.normalizationInsensitive === "yes";
  if (fold && normalize) {
    // Canonical caseless matching (Unicode D145), re-composed so the key is stable.
    return foldCase(relativePath.normalize("NFD"))
      .normalize("NFD")
      .normalize("NFC");
  }
  if (fold) return foldCase(relativePath);
  if (normalize) return relativePath.normalize("NFC");
  return relativePath;
}

/**
 * The identity key of a file document. This is the only place in the front end that builds a
 * `${directoryId}:${path}` string; everything else asks for the key.
 */
export function documentIdentityKey(
  directoryId: number,
  relativePath: string,
  semantics: PathSemantics,
): string {
  return `${directoryId}:${pathKeyOf(relativePath, semantics)}`;
}

// Path semantics of a project root (PD-10). The types mirror the Rust `PathSemantics`
// (camelCase, string tri-state); the key function arrives with the front-end work.

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

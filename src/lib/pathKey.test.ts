import { describe, expect, it } from "vitest";
import vectorFile from "../../contracts/path-key/path-key-vectors.json";
import {
  documentIdentityKey,
  pathKeyOf,
  UNKNOWN_PATH_SEMANTICS,
  type PathSemantics,
} from "./pathKey";

interface Vector {
  name: string;
  semantics: PathSemantics;
  relative: string;
  key: string | null;
  note: string;
}

const vectors = vectorFile.vectors as Vector[];
const asserted = vectors.filter((vector) => vector.key !== null);

describe("pathKeyOf", () => {
  it("has the shared vectors the Rust side asserts", () => {
    // 8 fixed vectors plus the thirteen research groups under six semantics.
    expect(vectors.length).toBeGreaterThanOrEqual(20);
    expect(asserted.length).toBeGreaterThanOrEqual(20);
  });

  it.each(asserted.map((vector) => [vector.name, vector] as const))(
    "matches the shared vector %s",
    (_name, vector) => {
      expect(pathKeyOf(vector.relative, vector.semantics)).toBe(vector.key);
    },
  );

  it("never folds when the case axis is sensitive or unknown", () => {
    const sensitive: PathSemantics = {
      case: "sensitive",
      normalizationInsensitive: "no",
    };
    for (const vector of vectors) {
      expect(pathKeyOf(vector.relative, sensitive), vector.name).toBe(
        vector.relative,
      );
      expect(
        pathKeyOf(vector.relative, UNKNOWN_PATH_SEMANTICS),
        vector.name,
      ).toBe(vector.relative);
    }
    // Reverse: an insensitive project does fold.
    expect(
      pathKeyOf("A.txt", {
        case: "insensitive",
        normalizationInsensitive: "no",
      }),
    ).toBe("a.txt");
  });

  it("normalizes to NFC only when the normalization axis is yes", () => {
    const decomposed = "é.txt";
    const composed = "é.txt";
    for (const kase of ["sensitive", "insensitive", "unknown"] as const) {
      expect(
        pathKeyOf(decomposed, { case: kase, normalizationInsensitive: "yes" }),
      ).toBe(composed);
      for (const normalization of ["no", "unknown"] as const) {
        expect(
          pathKeyOf(decomposed, {
            case: kase,
            normalizationInsensitive: normalization,
          }),
        ).toBe(decomposed);
      }
    }
    // Reverse: the normalization axis alone does not fold case.
    expect(
      pathKeyOf("É.txt", {
        case: "sensitive",
        normalizationInsensitive: "yes",
      }),
    ).toBe("É.txt");
  });

  it("builds document identity keys only through documentIdentityKey", () => {
    expect(
      documentIdentityKey(7, "Dir/A.txt", {
        case: "insensitive",
        normalizationInsensitive: "no",
      }),
    ).toBe("7:dir/a.txt");
    expect(documentIdentityKey(7, "Dir/A.txt", UNKNOWN_PATH_SEMANTICS)).toBe(
      "7:Dir/A.txt",
    );
  });
});

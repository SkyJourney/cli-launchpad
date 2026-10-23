import type { Directory } from "./tauri";

/** Pinned first, then `sortOrder` ascending, then name ascending; optional name search. */
export function orderProjectDirectories(
  directories: readonly Directory[],
  searchTerm: string,
): Directory[] {
  const term = searchTerm.trim().toLocaleLowerCase();
  return [...directories]
    .filter(
      (directory) => !term || directory.name.toLocaleLowerCase().includes(term),
    )
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);
    });
}

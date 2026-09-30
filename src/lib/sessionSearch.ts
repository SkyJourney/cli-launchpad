export const SESSION_SEARCH_BATCH_SIZE = 10;

export function shouldRefreshSessionSearchIndex(
  active: boolean,
  directoryId: number | null,
) {
  return active && directoryId != null;
}

export function shouldSearchSessions(input: {
  active: boolean;
  projectChanged: boolean;
  directoryId: number | null;
  indexReady: boolean;
  query: string;
}) {
  return (
    input.active &&
    !input.projectChanged &&
    input.directoryId != null &&
    input.indexReady &&
    input.query.length > 0
  );
}

export function getVisibleSearchResults<T>(items: T[], visibleCount: number) {
  return items.slice(0, visibleCount);
}

export function hasMoreSearchResults<T>(items: T[], visibleCount: number) {
  return visibleCount < items.length;
}

export function nextSearchVisibleCount(visibleCount: number) {
  return visibleCount + SESSION_SEARCH_BATCH_SIZE;
}

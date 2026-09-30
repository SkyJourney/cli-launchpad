import { describe, expect, it } from "vitest";
import {
  getVisibleSearchResults,
  hasMoreSearchResults,
  nextSearchVisibleCount,
  shouldRefreshSessionSearchIndex,
  shouldSearchSessions,
  SESSION_SEARCH_BATCH_SIZE,
} from "./sessionSearch";

describe("session search result batches", () => {
  it("reveals ten additional results at a time without fetching another page", () => {
    const items = Array.from({ length: 25 }, (_, index) => `session-${index}`);

    expect(
      getVisibleSearchResults(items, SESSION_SEARCH_BATCH_SIZE),
    ).toHaveLength(10);
    expect(hasMoreSearchResults(items, SESSION_SEARCH_BATCH_SIZE)).toBe(true);

    const secondBatchCount = nextSearchVisibleCount(SESSION_SEARCH_BATCH_SIZE);
    expect(getVisibleSearchResults(items, secondBatchCount)).toHaveLength(20);
    expect(hasMoreSearchResults(items, secondBatchCount)).toBe(true);

    const finalBatchCount = nextSearchVisibleCount(secondBatchCount);
    expect(getVisibleSearchResults(items, finalBatchCount)).toHaveLength(25);
    expect(hasMoreSearchResults(items, finalBatchCount)).toBe(false);
  });
});

describe("session search index lifecycle", () => {
  it("refreshes only the active project's index", () => {
    expect(shouldRefreshSessionSearchIndex(true, 12)).toBe(true);
    expect(shouldRefreshSessionSearchIndex(false, 12)).toBe(false);
    expect(shouldRefreshSessionSearchIndex(true, null)).toBe(false);
  });

  it("runs a search only after the active project's index is ready", () => {
    const base = {
      active: true,
      projectChanged: false,
      directoryId: 12,
      indexReady: true,
      query: "launchpad",
    };
    expect(shouldSearchSessions(base)).toBe(true);
    expect(shouldSearchSessions({ ...base, active: false })).toBe(false);
    expect(shouldSearchSessions({ ...base, projectChanged: true })).toBe(false);
    expect(shouldSearchSessions({ ...base, indexReady: false })).toBe(false);
    expect(shouldSearchSessions({ ...base, query: "" })).toBe(false);
  });
});

import test from "node:test";
import assert from "node:assert/strict";
import { filterRecentUniqueArticles, NEWS_LOOKBACK_MS } from "../src/news-filter.mjs";

const NOW = Date.parse("2026-11-02T06:00:00.000Z");

test("keeps only timestamped articles from the preceding hour", () => {
  const result = filterRecentUniqueArticles([
    { id: "fresh", title: "Fresh", published_at: "2026-11-02T05:30:00.000Z" },
    { id: "boundary", title: "Boundary", published_at: new Date(NOW - NEWS_LOOKBACK_MS).toISOString() },
    { id: "old", title: "Old", published_at: "2026-11-02T04:59:59.999Z" },
    { id: "future", title: "Future", published_at: "2026-11-02T06:00:01.000Z" },
    { id: "missing", title: "Missing timestamp" },
    { id: "invalid", title: "Invalid timestamp", published_at: "not-a-date" }
  ], NOW);
  assert.deepEqual(result.map(article => article.id), ["fresh", "boundary"]);
});

test("deduplicates URLs after removing tracking query parameters and fragments", () => {
  const result = filterRecentUniqueArticles([
    { title: "A", url: "https://example.com/story?utm_source=feed&id=7#top", published_at: "2026-11-02T05:40:00.000Z" },
    { title: "A copy", url: "https://EXAMPLE.com/story?id=7&utm_medium=social", published_at: "2026-11-02T05:41:00.000Z" }
  ], NOW);
  assert.equal(result.length, 1);
});

test("deduplicates by stable ID when URL is absent", () => {
  const result = filterRecentUniqueArticles([
    { id: "wire-123", title: "Headline A", published_at: "2026-11-02T05:30:00.000Z" },
    { id: "wire-123", title: "Headline B", published_at: "2026-11-02T05:31:00.000Z" }
  ], NOW);
  assert.equal(result.length, 1);
});

test("supports epoch-second publication timestamps", () => {
  const result = filterRecentUniqueArticles([
    { id: "epoch", title: "Epoch timestamp", published_at: (NOW - 10 * 60 * 1000) / 1000 }
  ], NOW);
  assert.equal(result.length, 1);
});

test("returns no articles for non-array input and ignores non-object entries", () => {
  assert.deepEqual(filterRecentUniqueArticles(null, NOW), []);
  assert.deepEqual(filterRecentUniqueArticles(["headline", null, 4], NOW), []);
});

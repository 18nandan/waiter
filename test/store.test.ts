import { describe, expect, it } from "vitest";
import { MemoryStore, cosine, stem, tokenize } from "../src/store.js";

function seededStore() {
  const s = new MemoryStore();
  s.add({ id: "m1", userId: "u1", content: "user: I bought a Trek bicycle in March for 800 dollars", metadata: { date: "2023-03-15" } });
  s.add({ id: "m2", userId: "u1", content: "user: My sister adopted a grey cat named Miso", metadata: { date: "2023-06-02" } });
  s.add({ id: "m3", userId: "u1", content: "user: I work as a nurse at the county hospital", metadata: { date: "2023-09-20" } });
  s.add({ id: "other", userId: "u2", content: "user: I also bought a bicycle", metadata: {} });
  return s;
}

describe("tokenize/stem", () => {
  it("collapses plurals without breaking the singular", () => {
    expect(stem("bicycles")).toBe(stem("bicycle"));
    expect(stem("names")).toBe(stem("name"));
    expect(stem("stories")).toBe("story");
    // Guards: these must not be mangled.
    expect(stem("process")).toBe("process");
    expect(stem("series")).not.toBe("serie");
  });

  it("drops stopwords", () => {
    expect(tokenize("what did I buy")).toEqual(["buy"]);
  });
});

describe("MemoryStore.keywordSearch", () => {
  it("matches literal substrings only", () => {
    const s = seededStore();
    expect(s.keywordSearch("u1", "Trek", 5).map((h) => h.memory.id)).toEqual(["m1"]);
    // v1 behaviour: no stemming, no partial-word semantics.
    expect(s.keywordSearch("u1", "bikes", 5)).toEqual([]);
  });
});

describe("MemoryStore.bm25Search", () => {
  it("ranks the matching memory first", () => {
    const s = seededStore();
    expect(s.bm25Search("u1", "cat named", 3)[0].memory.id).toBe("m2");
    expect(s.bm25Search("u1", "hospital nurse", 3)[0].memory.id).toBe("m3");
  });

  it("handles plurals via stemming", () => {
    const s = seededStore();
    expect(s.bm25Search("u1", "bicycles", 3)[0].memory.id).toBe("m1");
  });

  it("never leaks another user's memories", () => {
    const s = seededStore();
    const hits = s.bm25Search("u1", "bicycle", 10);
    expect(hits.every((h) => h.memory.userId === "u1")).toBe(true);
  });

  it("reflects writes made after the index was built", () => {
    const s = seededStore();
    s.bm25Search("u1", "warm up the index", 3);
    s.add({ id: "m4", userId: "u1", content: "user: I started learning to sail" });
    expect(s.bm25Search("u1", "sail", 3)[0].memory.id).toBe("m4");
  });
});

describe("MemoryStore.vectorSearch", () => {
  it("orders by cosine similarity and skips memories without vectors", () => {
    const s = new MemoryStore();
    s.add({ id: "a", userId: "u", content: "bicycle", embedding: [1, 0, 0] });
    s.add({ id: "b", userId: "u", content: "cat", embedding: [0, 1, 0] });
    s.add({ id: "c", userId: "u", content: "no vector here" });
    const hits = s.vectorSearch("u", [0.9, 0.1, 0], 5);
    expect(hits.map((h) => h.memory.id)).toEqual(["a", "b"]);
  });
});

describe("MemoryStore.hybridSearch", () => {
  it("fuses lexical and dense hits with RRF", () => {
    const s = new MemoryStore();
    // Lexical match on "bicycle" but an orthogonal vector; the reverse for "bike".
    s.add({ id: "lex", userId: "u", content: "bicycle purchase", embedding: [0, 1] });
    s.add({ id: "dense", userId: "u", content: "two wheeler", embedding: [1, 0] });
    const hits = s.hybridSearch({ userId: "u", query: "bicycle", queryEmbedding: [1, 0], limit: 2 });
    expect(hits.map((h) => h.memory.id).sort()).toEqual(["dense", "lex"]);
    const lex = hits.find((h) => h.memory.id === "lex")!;
    expect(lex.sources).toContain("bm25");
  });

  it("applies a recency prior when asked", () => {
    const s = new MemoryStore();
    s.add({ id: "old", userId: "u", content: "bicycle", metadata: { date: "2020-01-01" } });
    s.add({ id: "new", userId: "u", content: "bicycle", metadata: { date: "2024-01-01" } });
    const without = s.hybridSearch({ userId: "u", query: "bicycle", limit: 2 });
    expect(without).toHaveLength(2);
    const withRecency = s.hybridSearch({ userId: "u", query: "bicycle", limit: 2, recencyWeight: 2 });
    expect(withRecency[0].memory.id).toBe("new");
  });
});

describe("cosine", () => {
  it("is 1 for identical vectors and 0 for orthogonal ones", () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([0, 0], [1, 0])).toBe(0);
  });
});

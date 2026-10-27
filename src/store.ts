import { v4 as uuidv4 } from "uuid";

/**
 * Waiter memory store.
 *
 * Storage is a plain in-process Map (durability is a known gap, see AGENTS.md).
 * What lives here is the *retrieval* layer, which is the part that decides
 * whether Waiter is a JSON bucket or a memory layer.
 *
 * Three retrievers, deliberately kept separable so they can be mixed:
 *   - keyword : v1 behaviour, exact substring match in insertion order
 *   - bm25    : lexical scoring with an incremental inverted index per user
 *   - vector  : cosine similarity over caller-supplied embeddings
 * plus `hybrid()` which fuses lexcial + vector results with Reciprocal Rank
 * Fusion and applies optional recency / group aggregation.
 */

export interface Memory {
  id: string;
  userId: string;
  content: string;
  metadata: Record<string, unknown>;
  embedding?: number[];
  createdAt: string;
  updatedAt?: string;
}

export interface AddMemoryInput {
  userId: string;
  content: string;
  metadata?: Record<string, unknown>;
  embedding?: number[];
  /** Supply to make the write idempotent / reconstructable (e.g. source doc id). */
  id?: string;
}

export interface ScoredMemory {
  memory: Memory;
  score: number;
  /** Which retriever(s) produced or supported this hit. */
  sources?: string[];
}

const STOPWORDS = new Set(
  ("a an the and or but if then than that this these those of in on at to for from by with is are was were be been " +
    "being do does did doing have has had having i me my we our you your he she it they them his her its their " +
    "as not no nor so too very can will just should now about above after again all also am any because before " +
    "below between both each few more most other some such only own same s t don d ll m o re ve y " +
    // Question words: they dominate queries and match almost every session, so
    // they carry no ranking signal.
    "what when where who whom whose why how which whom while during").split(" "),
);

/**
 * Plural-only suffix stripping. Deliberately not Porter: stripping "ed"/"ing"
 * without a lexicon creates *new* mismatches ("named" -> "nam" never matches
 * "name"), and singular/plural is the pair that actually shows up in queries.
 * Applied identically to documents and queries so the two always agree.
 */
export function stem(t: string): string {
  if (t.length > 5 && t.endsWith("ies")) return t.slice(0, -3) + "y";
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") && !t.endsWith("us") && !t.endsWith("is")) {
    return t.slice(0, -1);
  }
  return t;
}

/** Lowercase alphanumeric-ish tokenisation. Light on purpose: no external NLP deps. */
export function tokenize(text: string): string[] {
  const raw = text.toLowerCase().split(/[^a-z0-9]+/);
  const out: string[] = [];
  for (const t of raw) {
    if (t.length < 2 || STOPWORDS.has(t)) continue;
    out.push(stem(t));
  }
  return out;
}

export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

interface Bm25Index {
  /** term -> (memoryId -> term frequency) */
  postings: Map<string, Map<string, number>>;
  /** memoryId -> document length in tokens */
  docLen: Map<string, number>;
  totalLen: number;
  /** Number of *indexed* docs for this user. */
  docCount: number;
}

export class MemoryStore {
  private memories = new Map<string, Memory>();
  /** userId -> inverted index, built lazily on first BM25 query. */
  private indexes = new Map<string, Bm25Index>();
  /** userId -> manually invalidated flag when writes land after an index build. */
  private indexDirty = new Set<string>();

  // ------------------------------------------------------------------ writes

  add(input: AddMemoryInput): Memory {
    const id = input.id ?? uuidv4();
    const now = new Date().toISOString();
    const existing = this.memories.get(id);
    const memory: Memory = {
      id,
      userId: input.userId,
      content: input.content,
      metadata: input.metadata ?? {},
      embedding: input.embedding,
      createdAt: existing?.createdAt ?? now,
      ...(existing ? { updatedAt: now } : {}),
    };
    this.memories.set(id, memory);
    this.indexMemory(memory, existing?.content);
    this.indexDirty.add(memory.userId);
    return memory;
  }

  get(id: string): Memory | undefined {
    return this.memories.get(id);
  }

  remove(id: string): boolean {
    const m = this.memories.get(id);
    if (!m) return false;
    this.memories.delete(id);
    this.indexDirty.add(m.userId);
    return true;
  }

  clear(): void {
    this.memories.clear();
    this.indexes.clear();
    this.indexDirty.clear();
  }

  get size(): number {
    return this.memories.size;
  }

  list(opts: { userId?: string; q?: string } = {}): Memory[] {
    const out: Memory[] = [];
    for (const m of this.memories.values()) {
      if (opts.userId && m.userId !== opts.userId) continue;
      out.push(m);
    }
    if (opts.q) {
      const needle = opts.q.toLowerCase();
      return out.filter((m) => m.content.toLowerCase().includes(needle));
    }
    return out;
  }

  // --------------------------------------------------------------- retrieval

  /**
   * v1 retriever: exact substring match, insertion order, no scoring.
   * Kept because it is the behaviour existing callers depend on.
   */
  keywordSearch(userId: string, query: string, limit = 10): ScoredMemory[] {
    const needle = query.toLowerCase();
    const hits: ScoredMemory[] = [];
    for (const m of this.memories.values()) {
      if (m.userId !== userId) continue;
      if (m.content.toLowerCase().includes(needle)) {
        hits.push({ memory: m, score: 1, sources: ["keyword"] });
      }
    }
    return hits.slice(0, limit);
  }

  /**
   * Fresh-up the inverted index if writes happened since it was built.
   * Undelete/overwrite handling is intentionally crude (rebuild) because
   * correctness beats micro-optimisation at this scale.
   */
  private ensureIndex(userId: string): Bm25Index {
    let idx = this.indexes.get(userId);
    if (!idx || this.indexDirty.has(userId)) {
      idx = { postings: new Map(), docLen: new Map(), totalLen: 0, docCount: 0 };
      this.indexes.set(userId, idx);
      this.indexDirty.delete(userId);
      for (const m of this.memories.values()) {
        if (m.userId === userId) this.indexMemory(m, undefined, idx);
      }
    }
    return idx;
  }

  private indexMemory(memory: Memory, previousContent: string | undefined, target?: Bm25Index): void {
    const idx = target ?? this.indexes.get(memory.userId);
    if (!idx) return; // no index yet; it will be built on first query
    if (previousContent !== undefined) {
      // Content changed: drop old postings for this doc.
      for (const [term, docs] of idx.postings) {
        if (docs.delete(memory.id)) {
          if (docs.size === 0) idx.postings.delete(term);
        }
      }
      const oldLen = idx.docLen.get(memory.id) ?? 0;
      idx.totalLen -= oldLen;
      idx.docCount -= 1;
      idx.docLen.delete(memory.id);
    }
    const tokens = tokenize(memory.content);
    if (tokens.length === 0) return;
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const [term, count] of tf) {
      let docs = idx.postings.get(term);
      if (!docs) {
        docs = new Map();
        idx.postings.set(term, docs);
      }
      docs.set(memory.id, count);
    }
    idx.docLen.set(memory.id, tokens.length);
    idx.totalLen += tokens.length;
    idx.docCount += 1;
  }

  /** Okapi BM25 over one user's memories. k1/b are the standard defaults. */
  bm25Search(
    userId: string,
    query: string,
    limit = 10,
    params: { k1?: number; b?: number } = {},
  ): ScoredMemory[] {
    const k1 = params.k1 ?? 1.2;
    const b = params.b ?? 0.75;
    const idx = this.ensureIndex(userId);
    const n = idx.docCount;
    if (n === 0) return [];
    const avgdl = idx.totalLen / n;
    const qTokens = tokenize(query);
    if (qTokens.length === 0) return [];

    const scores = new Map<string, number>();
    for (const term of new Set(qTokens)) {
      const docs = idx.postings.get(term);
      if (!docs) continue;
      const df = docs.size;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      for (const [docId, tf] of docs) {
        const dl = idx.docLen.get(docId) ?? 0;
        const denom = tf + k1 * (1 - b + (b * dl) / (avgdl || 1));
        const gain = idf * ((tf * (k1 + 1)) / (denom || 1));
        scores.set(docId, (scores.get(docId) ?? 0) + gain);
      }
    }

    const ranked: ScoredMemory[] = [];
    for (const [docId, score] of scores) {
      const memory = this.memories.get(docId);
      if (memory) ranked.push({ memory, score, sources: ["bm25"] });
    }
    ranked.sort((x, y) => y.score - x.score);
    return ranked.slice(0, limit);
  }

  /** Cosine similarity against pre-computed embeddings. */
  vectorSearch(userId: string, queryEmbedding: number[], limit = 10): ScoredMemory[] {
    const scored: ScoredMemory[] = [];
    for (const m of this.memories.values()) {
      if (m.userId !== userId || !m.embedding || m.embedding.length === 0) continue;
      scored.push({ memory: m, score: cosine(m.embedding, queryEmbedding), sources: ["vector"] });
    }
    scored.sort((x, y) => y.score - x.score);
    return scored.slice(0, limit);
  }

  /**
   * Fuse lexical and vector rankings with Reciprocal Rank Fusion, optionally
   * applying a recency prior. RRF is score-scale free, so a BM25 score and a
   * cosine similarity can be combined without calibration.
   */
  hybridSearch(opts: {
    userId: string;
    query: string;
    queryEmbedding?: number[];
    limit?: number;
    /** Rank-fusion constant. 60 is the value from the original RRF paper. */
    rrfK?: number;
    /** Extra weight for more recent memories (0 = off). */
    recencyWeight?: number;
    now?: Date;
  }): ScoredMemory[] {
    const limit = opts.limit ?? 10;
    const rrfK = opts.rrfK ?? 60;
    const lexical = this.bm25Search(opts.userId, opts.query, Math.max(limit * 4, 40));
    const dense = opts.queryEmbedding
      ? this.vectorSearch(opts.userId, opts.queryEmbedding, Math.max(limit * 4, 40))
      : [];

    const fused = new Map<string, ScoredMemory>();
    const addList = (list: ScoredMemory[], tag: string) => {
      list.forEach((hit, rank) => {
        const prev = fused.get(hit.memory.id);
        const contribution = 1 / (rrfK + rank + 1);
        if (prev) {
          prev.score += contribution;
          prev.sources = [...(prev.sources ?? []), tag];
        } else {
          fused.set(hit.memory.id, {
            memory: hit.memory,
            score: contribution,
            sources: [tag],
          });
        }
      });
    };
    addList(lexical, "bm25");
    addList(dense, "vector");

    if (opts.recencyWeight && opts.recencyWeight > 0) {
      const now = (opts.now ?? new Date()).getTime();
      const times = [...fused.values()]
        .map((h) => Date.parse(String(h.memory.metadata?.date ?? h.memory.createdAt)))
        .filter((t) => !Number.isNaN(t));
      const maxTime = times.length ? Math.max(...times) : now;
      for (const hit of fused.values()) {
        const t = Date.parse(String(hit.memory.metadata?.date ?? hit.memory.createdAt));
        if (Number.isNaN(t)) continue;
        const ageDays = Math.max(0, (maxTime - t) / 86_400_000);
        // Exponential decay over ~180 days.
        hit.score *= 1 + opts.recencyWeight * Math.exp(-ageDays / 180);
      }
    }

    const out = [...fused.values()].sort((a, b) => b.score - a.score);
    return out.slice(0, limit);
  }
}

/** Process-wide store used by the HTTP server. */
export const store = new MemoryStore();

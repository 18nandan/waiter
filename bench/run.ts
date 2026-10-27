/**
 * LongMemEval (S, cleaned) retrieval benchmark for Waiter.
 *
 * This runs the retrieval half of LongMemEval under the benchmark's own
 * configuration: each question's haystack sessions are the corpus (one memory
 * per session, scoped by userId), the question is the query, and a hit counts
 * when a returned session id is in `answer_session_ids`. Metrics are
 * session-level Recall@k, NDCG@10, MRR@20 and retrieved-token cost.
 *
 * The QA-accuracy half of LongMemEval needs an answerer LLM plus an
 * LLM-as-judge, which this machine has no credentials for; see
 * results/REPORT.md for what that means for the comparison.
 *
 *   npx tsx bench/run.ts            # full evaluation
 *   npx tsx bench/run.ts --quick    # 60 questions, for smoke tests
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline, env } from "@xenova/transformers";
import { MemoryStore, tokenize } from "../src/store.js";

const ROOT = path.resolve(import.meta.dirname ?? ".");
const CACHE = path.join(ROOT, "cache");
const OUT = path.join(ROOT, "results");
const DIM = 384;
const KS = [1, 3, 5, 10, 20];

env.cacheDir = path.join(ROOT, "models");
env.allowLocalModels = false;

type Turn = { role: string; content: string; has_answer?: boolean };
type Question = {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  question_date: string;
  haystack_session_ids: string[];
  haystack_dates: string[];
  haystack_sessions: Turn[][];
  answer_session_ids: string[];
};

const sha1 = (s: string) => crypto.createHash("sha1").update(s).digest("hex");

/** Mirrors bench/embed.ts — the two must stay in sync or the cache misses. */
function sessionDigest(turns: Turn[]): string {
  const userText = turns.filter((t) => t.role === "user").map((t) => t.content.trim()).join(" ");
  const fallback = turns.map((t) => t.content.trim()).join(" ");
  return (userText || fallback).slice(0, 1100);
}

function loadEmbeddingCache() {
  const binPath = path.join(CACHE, "embeddings.bin");
  const indexPath = path.join(CACHE, "embeddings.index.json");
  if (!fs.existsSync(binPath) || !fs.existsSync(indexPath)) {
    throw new Error("embedding cache missing — run `npx tsx bench/embed.ts` first");
  }
  const raw = fs.readFileSync(binPath);
  const rows = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const index: Record<string, number> = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  return {
    size: Object.keys(index).length,
    get(hash: string): number[] | undefined {
      const row = index[hash];
      if (row === undefined) return undefined;
      return Array.from(rows.subarray(row * DIM, (row + 1) * DIM));
    },
  };
}

// ---------------------------------------------------------------- metrics

interface QueryResult {
  questionId: string;
  questionType: string;
  ranked: string[]; // session ids, best first
  relevant: string[];
  retrievedTokens: number; // tokens in the top-K window, per K (see below)
  latencyMs: number;
}

function recallAt(ranked: string[], relevant: Set<string>, k: number): number {
  if (relevant.size === 0) return 0;
  let hits = 0;
  for (let i = 0; i < Math.min(k, ranked.length); i++) if (relevant.has(ranked[i])) hits++;
  return hits / relevant.size;
}

function ndcgAt(ranked: string[], relevant: Set<string>, k: number): number {
  let dcg = 0;
  for (let i = 0; i < Math.min(k, ranked.length); i++) {
    if (relevant.has(ranked[i])) dcg += 1 / Math.log2(i + 2);
  }
  let idcg = 0;
  const idealHits = Math.min(relevant.size, k);
  for (let i = 0; i < idealHits; i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

function mrrAt(ranked: string[], relevant: Set<string>, k: number): number {
  for (let i = 0; i < Math.min(k, ranked.length); i++) {
    if (relevant.has(ranked[i])) return 1 / (i + 1);
  }
  return 0;
}

function summarize(values: number[]) {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1);
  const sd = Math.sqrt(variance);
  const se = sd / Math.sqrt(n);
  const sorted = [...values].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length / 2)] ?? 0;
  return { mean, sd, ci95: 1.96 * se, p50, n };
}

// ---------------------------------------------------------------- retrieval

/** Stable 70/30 dev/test split so tuning never sees the reported split. */
function splitOf(questionId: string): "dev" | "test" {
  const h = parseInt(sha1(questionId).slice(0, 8), 16);
  return h % 10 < 3 ? "dev" : "test";
}

type ConfigName = "keyword-v1" | "bm25" | "vector" | "hybrid" | "hybrid+exp";

interface ConfigOutcome {
  ranked: string[];
  latencyMs: number;
}

/** Query expansion: append the strongest terms from the current top hits (RM3-style). */
function expandQuery(question: string, topDocs: string[], terms = 6): string {
  const df = new Map<string, number>();
  for (const doc of topDocs) {
    for (const t of new Set(tokenize(doc))) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const qTerms = new Set(tokenize(question));
  const added = [...df.entries()]
    .filter(([t]) => !qTerms.has(t) && t.length > 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, terms)
    .map(([t]) => t);
  return added.length ? `${question} ${added.join(" ")}` : question;
}

function runConfig(
  config: ConfigName,
  store: MemoryStore,
  question: Question,
  queryEmbedding: number[],
  sessionIdOf: (memoryId: string) => string,
  recencyWeight: number,
): ConfigOutcome {
  const t0 = performance.now();
  let hits: { memory: { id: string }; score: number }[] = [];

  switch (config) {
    case "keyword-v1":
      hits = store.keywordSearch(question.question_id, question.question, 20);
      break;
    case "bm25":
      hits = store.bm25Search(question.question_id, question.question, 20);
      break;
    case "vector":
      hits = store.vectorSearch(question.question_id, queryEmbedding, 20);
      break;
    case "hybrid":
      hits = store.hybridSearch({
        userId: question.question_id,
        query: question.question,
        queryEmbedding,
        limit: 20,
        recencyWeight,
      });
      break;
    case "hybrid+exp": {
      const first = store.hybridSearch({
        userId: question.question_id,
        query: question.question,
        queryEmbedding,
        limit: 5,
        recencyWeight,
      });
      const expanded = expandQuery(
        question.question,
        first.map((h) => h.memory.content),
      );
      hits = store.hybridSearch({
        userId: question.question_id,
        query: expanded,
        queryEmbedding,
        limit: 20,
        recencyWeight,
      });
      break;
    }
  }

  const latencyMs = performance.now() - t0;
  // Deduplicate by session, keeping the best rank.
  const seen = new Set<string>();
  const ranked: string[] = [];
  for (const h of hits) {
    const sid = sessionIdOf(h.memory.id);
    if (seen.has(sid)) continue;
    seen.add(sid);
    ranked.push(sid);
  }
  return { ranked, latencyMs };
}

// ---------------------------------------------------------------- main

async function main() {
  const quick = process.argv.includes("--quick");
  const questions: Question[] = JSON.parse(
    fs.readFileSync(path.join(ROOT, "data/longmemeval_s_cleaned.json"), "utf8"),
  );
  const subset = quick ? questions.slice(0, 60) : questions;
  const embCache = loadEmbeddingCache();
  console.log(`questions: ${subset.length} | cached vectors: ${embCache.size}`);

  // Query embeddings, computed once and reused across configs.
  const qCachePath = path.join(CACHE, "query_embeddings.json");
  const qCache: Record<string, number[]> = fs.existsSync(qCachePath)
    ? JSON.parse(fs.readFileSync(qCachePath, "utf8"))
    : {};
  const missing = subset.filter((q) => !qCache[q.question_id]);
  if (missing.length) {
    console.log(`embedding ${missing.length} queries...`);
    const extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
      quantized: true,
    });
    for (let i = 0; i < missing.length; i += 16) {
      const slice = missing.slice(i, i + 16);
      const out = await extractor(
        slice.map((q) => q.question),
        { pooling: "mean", normalize: true },
      );
      const data = out.data as Float32Array;
      slice.forEach((q, r) => {
        qCache[q.question_id] = Array.from(data.subarray(r * DIM, (r + 1) * DIM));
      });
    }
    fs.writeFileSync(qCachePath, JSON.stringify(qCache));
  }

  const configs: ConfigName[] = ["keyword-v1", "bm25", "vector", "hybrid", "hybrid+exp"];
  type Raw = Map<ConfigName, QueryResult[]>;
  const results: Raw = new Map(configs.map((c) => [c, [] as QueryResult[]]));
  const warnings = { missingVectors: 0 };

  // ---- Pass 1: dev split, to pick the recency weight honestly.
  const recencyGrid = [0, 0.5, 1, 2];
  const devScores = new Map<number, number[]>();
  for (const w of recencyGrid) devScores.set(w, []);

  for (const question of subset) {
    const relevant = new Set(question.answer_session_ids);
    const store = new MemoryStore();
    const sessionIdOfMap = new Map<string, string>();
    let missingVectors = 0;

    for (let i = 0; i < question.haystack_sessions.length; i++) {
      const turns = question.haystack_sessions[i];
      const digest = sessionDigest(turns);
      const sid = question.haystack_session_ids[i] ?? `sess_${i}`;
      const memoryId = `m_${i}`;
      sessionIdOfMap.set(memoryId, sid);
      const vec = embCache.get(sha1(digest));
      if (!vec) missingVectors++;
      store.add({
        id: memoryId,
        userId: question.question_id,
        content: turns.map((t) => `${t.role}: ${t.content}`).join("\n"),
        metadata: { sessionId: sid, date: question.haystack_dates[i], turnCount: turns.length },
        embedding: vec,
      });
    }
    if (missingVectors > 0) warnings.missingVectors += missingVectors;
    // Build the BM25 index before recording any timings, so the first config
    // measured does not absorb the one-time indexing cost that later configs
    // would otherwise skip. All reported latencies are warm-query.
    store.bm25Search(question.question_id, "warmup", 1);
    const sessionIdOf = (id: string) => sessionIdOfMap.get(id) ?? id;
    if (splitOf(question.question_id) === "dev") {
      for (const w of recencyGrid) {
        const { ranked } = runConfig("hybrid", store, question, qCache[question.question_id], sessionIdOf, w);
        devScores.get(w)!.push(recallAt(ranked, relevant, 10));
      }
      continue; // dev questions are not reported
    }

    for (const config of configs) {
      // Hybrid variants share the tuned recency weight, applied below.
      const { ranked, latencyMs } = runConfig(
        config,
        store,
        question,
        qCache[question.question_id],
        sessionIdOf,
        0,
      );
      results.get(config)!.push({
        questionId: question.question_id,
        questionType: question.question_type,
        ranked,
        relevant: [...relevant],
        retrievedTokens: 0, // filled after tuning so every config uses one weight
        latencyMs,
      });
    }
  }

  // Pick recency weight on dev recall@10.
  const devMeans = recencyGrid.map((w) => ({
    w,
    r10: devScores.get(w)!.reduce((a, b) => a + b, 0) / Math.max(1, devScores.get(w)!.length),
  }));
  const bestWeight = devMeans.sort((a, b) => b.r10 - a.r10)[0]?.w ?? 0;
  console.log("dev recall@10 by recency weight:", devMeans.map((d) => `${d.w}:${d.r10.toFixed(3)}`).join(" "));
  console.log(`chosen recencyWeight=${bestWeight}`);

  // ---- Pass 2: if the tuned weight is non-zero, re-rank hybrid configs on test.
  if (bestWeight !== 0) {
    for (const config of ["hybrid", "hybrid+exp"] as ConfigName[]) {
      for (const row of results.get(config)!) {
        const question = subset.find((q) => q.question_id === row.questionId)!;
        const store = new MemoryStore();
        const sessionIdOfMap = new Map<string, string>();
        question.haystack_sessions.forEach((turns, i) => {
          const sid = question.haystack_session_ids[i] ?? `sess_${i}`;
          const memoryId = `m_${i}`;
          sessionIdOfMap.set(memoryId, sid);
          store.add({
            id: memoryId,
            userId: question.question_id,
            content: turns.map((t) => `${t.role}: ${t.content}`).join("\n"),
            metadata: { sessionId: sid, date: question.haystack_dates[i], turnCount: turns.length },
            embedding: embCache.get(sha1(sessionDigest(turns))),
          });
        });
        const out = runConfig(
          config,
          store,
          question,
          qCache[question.question_id],
          (id) => sessionIdOfMap.get(id) ?? id,
          bestWeight,
        );
        row.ranked = out.ranked;
        row.latencyMs = out.latencyMs;
      }
    }
  }

  // ---- Aggregate.
  if (warnings.missingVectors > 0) {
    console.warn(
      `WARNING: ${warnings.missingVectors} sessions had no cached embedding; vector and hybrid scores are understated. Run bench/embed.ts to completion.`,
    );
  }
  const report: any = {
    benchmark: "LongMemEval-S (cleaned)",
    questionsEvaluated: results.get("bm25")!.length,
    devQuestions: subset.length - results.get("bm25")!.length,
    configs: {},
    perType: {},
    tuning: { recencyGrid: devMeans, chosen: bestWeight },
    warnings,
    datasetTokens: 0,
  };

  for (const config of configs) {
    const rows = results.get(config)!;
    const metrics: Record<string, any> = {};
    for (const k of KS) {
      metrics[`recall@${k}`] = summarize(rows.map((r) => recallAt(r.ranked, new Set(r.relevant), k)));
    }
    metrics["ndcg@10"] = summarize(rows.map((r) => ndcgAt(r.ranked, new Set(r.relevant), 10)));
    metrics["mrr@20"] = summarize(rows.map((r) => mrrAt(r.ranked, new Set(r.relevant), 20)));
    metrics["latency_ms"] = summarize(rows.map((r) => r.latencyMs));
    report.configs[config] = metrics;
  }

  // Per-question-type breakdown. R@20 saturates on this split, so R@1 is the
  // figure that actually separates the retrievers.
  const types = [...new Set(results.get("bm25")!.map((r) => r.questionType))].sort();
  for (const type of types) {
    report.perType[type] = {};
    for (const config of configs) {
      const rows = results.get(config)!.filter((r) => r.questionType === type);
      report.perType[type][config] = {
        ...summarize(rows.map((r) => recallAt(r.ranked, new Set(r.relevant), 20))),
        r20: summarize(rows.map((r) => recallAt(r.ranked, new Set(r.relevant), 20))).mean,
        r1: summarize(rows.map((r) => recallAt(r.ranked, new Set(r.relevant), 1))).mean,
      };
    }
  }

  // Token cost: average history size vs tokens a reader would receive.
  const allQ = subset.filter((q) => splitOf(q.question_id) === "test");
  const historyTokens =
    allQ.reduce(
      (sum, q) =>
        sum + q.haystack_sessions.reduce((s, t) => s + t.reduce((x, y) => x + y.content.length / 4, 0), 0),
      0,
    ) / Math.max(1, allQ.length);
  report.datasetTokens = Math.round(historyTokens);

  // Cost of reading the top-k sessions back into a prompt.
  for (const config of configs) {
    const rows = results.get(config)!;
    const perK: Record<string, number> = {};
    for (const k of [5, 10, 20]) {
      let total = 0;
      for (const row of rows) {
        const q = allQ.find((x) => x.question_id === row.questionId)!;
        const idToTokens = new Map<string, number>();
        q.haystack_session_ids.forEach((sid, i) => {
          idToTokens.set(sid, q.haystack_sessions[i].reduce((a, t) => a + t.content.length / 4, 0));
        });
        for (const sid of row.ranked.slice(0, k)) total += idToTokens.get(sid) ?? 0;
      }
      perK[`top${k}`] = Math.round(total / rows.length);
    }
    report.configs[config].tokens = perK;
  }

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(report, null, 2));

  // Console summary.
  console.log(`\n=== LongMemEval-S cleaned | ${report.questionsEvaluated} test questions ===`);
  console.log(`avg full history: ${report.datasetTokens} tokens/question\n`);
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(pad("config", 14), pad("R@1", 8), pad("R@5", 8), pad("R@10", 8), pad("R@20", 8), pad("NDCG@10", 9), pad("MRR@20", 8), pad("ms", 6), "top10 tok");
  for (const config of configs) {
    const m = report.configs[config];
    console.log(
      pad(config, 14),
      pad(m["recall@1"].mean.toFixed(3), 8),
      pad(m["recall@5"].mean.toFixed(3), 8),
      pad(m["recall@10"].mean.toFixed(3), 8),
      pad(m["recall@20"].mean.toFixed(3), 8),
      pad(m["ndcg@10"].mean.toFixed(3), 9),
      pad(m["mrr@20"].mean.toFixed(3), 8),
      pad(m["latency_ms"].mean.toFixed(1), 6),
      m.tokens.top10,
    );
  }
  console.log("\nwrote", path.join(OUT, "results.json"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

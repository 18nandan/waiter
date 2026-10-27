# Waiter - self-hosted memory retrieval for AI

Waiter is a small, open-source Node.js API for storing scoped memories and retrieving them with lexical (BM25), optional dense-vector, or hybrid search. It is designed to be straightforward to inspect, run locally, and benchmark—not to claim feature parity with managed memory platforms.

**Current scope:** API + retrieval, with in-process storage. Waiter does not currently extract facts, generate embeddings, synthesize profiles, persist data across restarts, or answer questions with an LLM. See the measured benchmark and limitations below.

| | |
|---|---|
| License | MIT; see [LICENSE](LICENSE) |
| Runtime | Node.js 20+, TypeScript, Express 4 |
| Search | BM25; optional cosine-vector search; Reciprocal Rank Fusion (RRF) |
| Storage | In-memory Maps (data is lost when the process exits) |
| Relationship | Independent clean-room project; separate from `tanu`; no Supermemory source code included |

**Quick links:** [Meeting brief PDF](bench/results/Waiter_Benchmark_Meeting_Brief.pdf) | [Full charted benchmark report](bench/results/waiter-longmemeval-report.pdf) | [Detailed comparison and math](MATHEMATICAL_PROOF_COMPARISON.md) | [Raw benchmark results](bench/results/results.json) | [Reproduction instructions](bench/README.md)

---

## Why Waiter exists

LLMs have limited working context across sessions. Memory infrastructure can store relevant information and retrieve it later. Waiter currently implements the storage API and retrieval step: callers add text under a `userId`, then search that scope. It does not automatically extract facts, provide a user-profile endpoint, or resolve contradictory facts yet; those are future work, not current capabilities.

## Benchmark results

### LongMemEval-S cleaned - retrieval only

Waiter was evaluated on the cleaned LongMemEval-S data with the local harness in [`bench/`](bench/README.md): 500 source questions, one memory per haystack session, a hash-based 70/30 dev/test split (365 held-out test questions), and all-MiniLM-L6-v2 embeddings on CPU. This measures **session retrieval**, not answer accuracy.

| Waiter configuration | Recall@1 (95% CI) | Recall@10 | Recall@20 (95% CI) | NDCG@10 | MRR@20 |
|---|---:|---:|---:|---:|---:|
| Keyword v1 | 0.1% ± 0.3 | 0.1% | 0.1% ± 0.3 | 0.2% | 0.3% |
| BM25 | 56.2% ± 3.4 | 95.2% | 97.8% ± 1.1 | 90.4% | 91.6% |
| Vector (MiniLM) | 51.1% ± 3.6 | 95.3% | 98.3% ± 1.0 | 87.0% | 86.6% |
| Hybrid RRF | 57.0% ± 3.3 | 96.9% | 98.8% ± 0.8 | 92.2% | 93.0% |
| Hybrid + query expansion | 57.1% ± 3.3 | 97.1% | 99.2% ± 0.7 | 92.4% | 93.1% |

**Interpretation, not marketing:**

- Hybrid RRF Recall@1 is 57.0% versus BM25's 56.2% (+0.7 percentage points observed). Their uncertainty intervals overlap; this run does **not** establish statistical superiority of hybrid over BM25.
- Recall@20 is saturated on this split. About 48 candidate sessions per question means top 20 covers over 40% of candidates; BM25 already reaches 97.8% without embeddings.
- Dense retrieval helped the small single-session-preference subgroup (n=23): Vector Recall@1 was 69.6%, BM25 43.5%. Treat subgroup findings as indicative, not conclusive.
- **QA/answer accuracy was not measured.** Waiter has no answerer model or LLM judge. Do not compare its retrieval recall directly with a vendor's end-to-end QA accuracy.
- Waiter's 98.8% Recall@20 and Supermemory's vendor-reported 97% Recall@20 are not a head-to-head result: Waiter's evaluation uses cleaned session-level retrieval without the same published aggregation protocol. The high-k metric is weakly discriminative here; this apparent difference is not evidence of a win or parity.

The meeting brief and full report include charts, category breakdowns, method, caveats, and an honest comparison with public Supermemory claims. Raw data: [`bench/results/results.json`](bench/results/results.json).

### Public comparison context

Supermemory's [LongMemEval report](https://supermemory.ai/research/longmembench/) reports 97% LongMemEval-S Recall@20 with aggregation. Its [GitHub README](https://github.com/supermemoryai/supermemory) separately advertises 95% Recall@15, 99.4% context reduction, and ~50 ms user profiles. Those are vendor-published claims and have not been independently reproduced in this repository.

Supermemory's README claims #1 on LoCoMo and ConvoMem, but this project has not run Waiter on either benchmark and makes no numeric comparison there. Its research report describes semantic chunking, atomic/contextual memories, knowledge relations, temporal grounding, and source chunks; Waiter currently implements BM25/optional vectors/RRF and lacks those higher-level memory features. See [detailed comparison](MATHEMATICAL_PROOF_COMPARISON.md).

No fair end-to-end winner can be declared here. A proper head-to-head needs the same dataset version, ingestion/aggregation protocol, answer model, judge prompts, token budget, and per-question outputs with paired confidence intervals.

## Architecture and current API

```text
Client/agent → Express JSON API → MemoryStore → in-process Maps
                                       ├─ BM25
                                       ├─ cosine vector search (optional supplied vectors)
                                       └─ Reciprocal Rank Fusion
```

Available routes: `GET /health`, `GET/POST /users`, `GET/POST /memories`, `POST /search`, `GET/POST /documents`, and `GET /stats`. See the detailed API contract in [`AGENTS.md`](AGENTS.md).

- **BM25**: Okapi BM25 retrieval, per-user index.
- **Vector**: cosine similarity over caller-supplied vectors. Waiter does not generate embeddings at runtime.
- **Hybrid**: RRF combines lexical and vector ranked lists; no learned cross-encoder reranker is currently implemented.
- **Storage**: in-process Maps. This is a local demo/research implementation, not durable or safe for multi-tenant production use.

### Quickstart

```bash
npm ci
npm run dev
# Health check: curl http://localhost:3000/health
```

Build and run compiled JS:

```bash
npm run build
npm start
```

### Reproduce the benchmark

See [`bench/README.md`](bench/README.md) for dataset acquisition, exact configuration, cache requirements, and caveats. In brief:

```bash
npx tsx bench/embed.ts   # one-time, resumable local embedding cache
npx tsx bench/run.ts     # writes bench/results/results.json
npm run bench:report     # generates the PDFs in bench/results/
```

The S dataset and embedding cache are large downloaded artifacts and are intentionally gitignored. Reported raw results are checked in so readers can inspect them without re-running inference.

## Known limitations / roadmap

- In-memory only; data disappears on restart.
- No authentication/tenant security boundary: `userId` is a filter, not access control.
- No fact extraction, profile synthesis, contradiction resolution, or automatic embedding generation.
- No ANN index or cross-encoder reranker.
- Benchmark uses one vector per session digest (user-turn text capped at 1,100 characters); BM25 sees full transcripts. Not equivalent to production ingestion systems.
- No QA accuracy evaluation; no Waiter LoCoMo or ConvoMem score.

Likely next experiments: chunk/turn-level retrieval with session aggregation, then reranking, durable storage, and a fully specified answerer-plus-judge evaluation. Results should be reported even if they do not improve.

## License and independence

Waiter is licensed under MIT; see [LICENSE](LICENSE). The benchmark data and third-party libraries retain their own licenses. Waiter is a clean-room independent project and does not include Supermemory code or binary. Waiter is also separate from the `tanu` project; integration is deferred.

## Sources

- [Supermemory GitHub repository and README](https://github.com/supermemoryai/supermemory)
- [Supermemory LongMemEval research report](https://supermemory.ai/research/longmembench/)
- [Official LongMemEval repository](https://github.com/xiaowu0162/LongMemEval)
- [LongMemEval cleaned dataset](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned)
- [LongMemEval paper](https://arxiv.org/abs/2410.10813)

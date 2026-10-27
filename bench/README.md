# Waiter benchmark harness

Retrieval evaluation of Waiter on **LongMemEval-S** (`longmemeval-cleaned`), the benchmark
Supermemory reports its headline numbers on.

This harness measures the *retrieval* half of LongMemEval: does the right evidence session
come back for a question? It does **not** measure QA accuracy, which needs an answerer model
plus an LLM judge. See [`../MATHEMATICAL_PROOF_COMPARISON.md`](../MATHEMATICAL_PROOF_COMPARISON.md)
for cross-system comparison rules and caveats.

## Data

Two files from [xiaowu0162/longmemeval-cleaned](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned)
(MIT licensed). Download into `bench/data/`:

```bash
curl -L -o bench/data/longmemeval_s_cleaned.json \
  "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json"
curl -L -o bench/data/longmemeval_oracle.json \
  "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json"
```

`longmemeval_s_cleaned.json` is ~277 MB: 500 questions, 23,867 haystack sessions, ~122k
tokens of history per question. The oracle split has only 3 sessions per question and is
included for sanity checks, not for scoring.

Both files and `bench/cache/` are gitignored — they are downloaded artefacts, not source.

## Run

```bash
npx tsx bench/embed.ts    # build the embedding cache (~18k texts, one-off, resumable)
npx tsx bench/run.ts      # evaluate, writes bench/results/results.json
npm run bench:report     # render full PDF and meeting brief in bench/results/
```

`bench/run.ts --quick` evaluates the first 60 questions for a fast smoke test.

Embedding on CPU is the bottleneck (~54 ms/text on the dev machine, so the cache build takes
roughly 15-25 minutes). It is cached by content hash, so re-running the benchmark after
changing retrieval settings is fast.

## What each configuration tests

| Config | Retriever | What it represents |
|---|---|---|
| `keyword-v1` | Exact substring match, insertion order | What Waiter shipped first |
| `bm25` | Okapi BM25 over an inverted index | Lexical baseline, no model |
| `vector` | Cosine over MiniLM-L6-v2 session digests | Semantic only |
| `hybrid` | RRF fusion of BM25 + vector, recency prior | The shipped default |
| `hybrid+exp` | Hybrid plus pseudo-relevance query expansion | Experimental |

The recency weight is chosen on a 30% dev split (by question-id hash) and applied to the
70% test split, so the reported numbers are not tuned on themselves.

## Metrics

- **Recall@k** — fraction of a question's evidence sessions in the top *k*.
- **NDCG@10** — rank-aware gain with binary relevance.
- **MRR@20** — reciprocal rank of the first evidence session.
- **tokens** — prompt cost of the retrieved sessions (`chars / 4`).
- **latency_ms** — in-process query time, no HTTP, no query embedding.

## Reproducibility notes

- One memory per haystack session, `userId = question_id`. This is how LongMemEval labels
  evidence; it is not a claim that per-question isolation is how Waiter would be deployed.
- The session embedding is a *digest* (user turns concatenated, capped at 1,100 chars)
  because MiniLM reads 256 tokens and a full session is ~2.5k. The digest choice matters;
  see the limitations section of the report.
- No hosted services, no API keys, no network at run time once the data and model are local.

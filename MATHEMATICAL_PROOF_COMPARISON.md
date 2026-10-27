# Waiter benchmark and Supermemory comparison

**Purpose:** a source-backed technical comparison for reviewers and contributors. This is not a claim of benchmark parity or universal superiority.

## Executive result

Waiter was run on the **cleaned LongMemEval-S retrieval task**: 500 source questions, 135 development questions for recency tuning, and 365 held-out test questions. The harness indexes one memory per evidence session and uses all-MiniLM-L6-v2 embeddings locally. Results below are retrieval metrics—not QA accuracy.

| Waiter configuration | Recall@1 (95% CI) | Recall@10 | Recall@20 (95% CI) | NDCG@10 | MRR@20 | Median retrieval latency |
|---|---:|---:|---:|---:|---:|---:|
| Keyword v1 | 0.1% ± 0.3 | 0.1% | 0.1% ± 0.3 | 0.2% | 0.3% | 0.38 ms |
| BM25 | 56.2% ± 3.4 | 95.2% | 97.8% ± 1.1 | 90.4% | 91.6% | 0.02 ms |
| Vector (MiniLM) | 51.1% ± 3.6 | 95.3% | 98.3% ± 1.0 | 87.0% | 86.6% | 0.04 ms |
| Hybrid RRF | 57.0% ± 3.3 | 96.9% | 98.8% ± 0.8 | 92.2% | 93.0% | 0.05 ms |
| Hybrid + query expansion | 57.1% ± 3.3 | 97.1% | 99.2% ± 0.7 | 92.4% | 93.1% | 1.63 ms |

These are the checked-in measurements in [`bench/results/results.json`](bench/results/results.json), not a theoretical estimate. Confidence intervals are the harness's normal-approximation 95% intervals across held-out questions. Hybrid's +0.7 percentage-point Recall@1 over BM25 is small relative to uncertainty; do not describe that delta as a statistically established win. The preference subgroup is only 23 questions.

## What can fairly be compared with Supermemory?

Supermemory's [LongMemEval research report](https://supermemory.ai/research/longmembench/) publishes **97% overall Recall@20 with aggregation** for LongMemEval-S, and tables for GPT-4o, GPT-5, Gemini 3 Pro, Zep, and full-context systems. Its [GitHub README](https://github.com/supermemoryai/supermemory) separately advertises **95% Recall@15**, **99.4% context reduction**, and **~50 ms user profiles**.

Those are Supermemory-published figures, not independently reproduced results. Waiter's run uses the cleaned dataset and a session-level retrieval metric, with no aggregation or answerer/judge pipeline. The protocols are not established as identical. **The superficial 98.8% Waiter Recall@20 versus Supermemory's 97% is not proof that Waiter is better or at parity.** Recall@20 is saturated here: BM25 alone obtains 97.8% when each question has roughly 48 candidate sessions. Supermemory's reported end-to-end evaluation and Waiter's retrieval-only experiment answer different questions.

| Claim | Waiter evidence | Supermemory public evidence | Fair conclusion |
|---|---|---|---|
| LongMemEval QA accuracy | Not measured: Waiter has no answerer or LLM judge | Vendor report publishes GPT-4o judged results | No accuracy winner can be declared |
| Retrieval Recall@20 | 98.8% hybrid; 97.8% BM25 on cleaned S split | 97% with aggregation, per vendor report | Similar headline values, but incompatible/unspecified protocol differences prevent a head-to-head claim |
| Recall@1 / MRR | Measured for Waiter (table above) | Not published in the cited report | No direct comparison |
| Context reduction | Top-5 Waiter hybrid+exp sessions cost 15,919 tokens versus 122,373 estimated full-history tokens (87.0% reduction) | README advertises 99.4% reduction (~720 tokens) | Supermemory reports a smaller context budget; answer quality under equal budgets is not measured here |
| Profile latency | Search p50 ~0.05 ms, warm, in-process; excludes embedding and HTTP | README advertises ~50 ms user profiles | Different operations and measurement scopes; not comparable |
| LoCoMo / ConvoMem | Not run in this repository | README claims #1; no numeric result is used here | No Waiter comparison available |

The token estimate is `characters / 4`, and the full-history and retrieved-context token estimates are not tokenizer-exact. Waiter's top-5 retrieval setting and Supermemory's advertised profile/context flow are also not identical.

## Waiter performance math

For a question `q`, let `G_q` be its relevant evidence-session IDs and `R_q` the ranked session IDs returned by the retriever. Session Recall@k is:

`Recall@k(q) = |G_q ∩ R_q[1:k]| / |G_q|`

The report is the arithmetic mean over the 365 held-out questions. NDCG@10 uses binary relevance with logarithmic rank discount; MRR@20 is the reciprocal rank of the first relevant session, or zero if none occurs in the first 20.

The reported CI for a metric mean is the harness's `mean ± 1.96 × sample_sd / sqrt(n)`. For example, Waiter Hybrid Recall@1 is `0.5697 ± 1.96 × 0.3236 / sqrt(365)`, i.e. **56.97% ± 3.32 percentage points**. This is uncertainty on Waiter's mean. It is not a paired significance test against another system. Per-question paired raw outputs for a Supermemory run do not exist, so we cannot calculate a paired p-value, bootstrap difference interval, or claim statistical superiority.

The strongest defensible improvement claim is within Waiter's own implementation, measured on the same split: moving from literal-substring keyword v1 (Recall@1 0.14%) to BM25 (56.24%) improves session retrieval by about **56.1 percentage points**. This shows the value of adding a real retriever; it does not show that Waiter beats Supermemory.

### Why use Reciprocal Rank Fusion?

Waiter combines BM25 and cosine-vector ranked lists using RRF:

`RRF(d) = 1 / (k + rank_BM25(d)) + 1 / (k + rank_vector(d))`

with `k = 60`; documents absent from a list contribute zero. RRF combines ranks rather than incomparable raw BM25 and cosine score scales. In this run, it improves measured Recall@1 from 56.2% (BM25) to 57.0% (hybrid), but the confidence intervals overlap. The fusion is a reasonable tested option, not a mathematical proof of superiority.

## Technology comparison (publicly described vs implemented)

| Area | Supermemory public description | Waiter implementation |
|---|---|---|
| Product scope | Memory extraction, user profiles, RAG/search, connectors, file processing and plugins/MCP | Small HTTP API for users, memories, documents and retrieval |
| Ingestion and memory | Research report describes semantic chunking, atomic memories, retained source chunks, and relations such as updates/extends/derives | Caller supplies memory text and optional vectors; documents are paragraph-chunked; no automatic fact extraction or relation/version model |
| Time | Research describes separate document and event dates | Creation timestamps and optional metadata; no built-in temporal knowledge model |
| Retrieval | Research describes semantic/hybrid retrieval and source-chunk return | Okapi BM25; optional cosine similarity; RRF rank fusion |
| Embeddings | Product says clients do not need to manage embedding pipelines | Caller supplies embeddings; benchmark uses local MiniLM-L6-v2 |
| Profiles / answer generation | Product offers profiles and an integrated memory/context flow | No profile synthesis, answer generation, or QA judge |
| Persistence / hosting | GitHub describes SaaS and a local/self-hosted option; internals are not all publicly specified | In-process Maps; self-hosted Node server; data is lost on restart |
| Licensing / openness | Public GitHub repository contains open-source components; features and distribution terms vary by component. Check the upstream license for each component before reuse. | This project is MIT-licensed (see [LICENSE](LICENSE)); no Supermemory source is copied |

This table intentionally does **not** guess Supermemory's private database, embedding provider, or service architecture. See the public report and repository links above for its own descriptions.

## Limitations and next tests

- Retrieval-only: no evidence about answer accuracy, groundedness, abstention, or answer quality.
- Cleaned S split, one memory per session, one vector per session digest; this does not reproduce every vendor ingestion/aggregation path.
- The dense side embeds user-turn digests truncated to 1,100 characters; BM25 sees the full session transcript. Assistant-turn and long-session questions can be affected by this asymmetry.
- Only MiniLM-L6-v2 was tested on this machine. Query embedding time is excluded from retrieval latency.
- `chars / 4` is a token-cost approximation, not the tokenizer used by an LLM.
- The 365-question sample gives meaningful uncertainty, and question categories are much smaller; avoid interpreting subgroup deltas as robust.
- No published numerical Waiter score exists here for LoCoMo or ConvoMem.
- The next fair system comparison is a paired end-to-end run: same dataset version, retrieval/aggregation budget, answerer model, judge prompts and token budget, plus per-question outputs and paired confidence intervals.

## Reproduce

See [`bench/README.md`](bench/README.md) for dataset acquisition, model cache, exact commands, split, and metrics. Raw results: [`bench/results/results.json`](bench/results/results.json). Full charted report: [`bench/results/waiter-longmemeval-report.pdf`](bench/results/waiter-longmemeval-report.pdf).

## Sources

- [Supermemory LongMemEval research report](https://supermemory.ai/research/longmembench/)
- [Supermemory GitHub repository and README](https://github.com/supermemoryai/supermemory)
- [Official LongMemEval repository](https://github.com/xiaowu0162/LongMemEval)
- [LongMemEval cleaned dataset](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned)
- [LongMemEval paper (arXiv)](https://arxiv.org/abs/2410.10813)

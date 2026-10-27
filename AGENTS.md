# AGENTS.md — Waiter memory layer

**You are working on Waiter, a self-hosted memory and context API for AI agents.** This file is the contract. Read it fully before editing code.

---

## 1. What Waiter is

A small Node.js + Express + TypeScript HTTP service that stores two kinds of things and returns them later:

- **Memories** — facts scoped to a `userId` (e.g. "prefers TypeScript", "working on auth migration").
- **Documents** — longer text bodies, split into paragraph chunks, scoped to a `userId`. Each chunk is also stored as a memory, so documents are searchable through the same path as memories.

It also holds **users**, which are just scope records.

**There is still no AI in this codebase.** No LLM calls and no embedding generation. Retrieval is real (BM25 + optional vector + fusion), but Waiter will not turn text into vectors for you: the caller supplies `embedding` on write and on query. If a task needs embeddings, you add the provider — it is not present.

**Do not** assume Supermemory feature parity. Connectors, OCR, user-profile synthesis, and knowledge-update logic are **not implemented** (see §10).

**Do not** claim QA accuracy on LongMemEval. Waiter has been benchmarked on the *retrieval* half only; README §2.6 has the measured numbers and their caveats.

---

## 2. Repository layout

```
waiter/
├── package.json           # name: waiter, ESM, npm scripts
├── tsconfig.json          # Node16 modules, strict, outDir dist, rootDir src
├── tsconfig.check.json    # typecheck for src + bench + test (noEmit)
├── README.md              # docs: benchmarks (incl. our own), API, roadmap
├── AGENTS.md              # this file
├── src/
│   ├── index.ts           # HTTP layer: routes, validation, error envelope
│   └── store.ts           # MemoryStore + retrievers (keyword, BM25, vector, hybrid)
├── test/
│   └── store.test.ts      # Vitest coverage of the retrievers
└── bench/                 # LongMemEval harness — see bench/README.md
    ├── embed.ts           # resumable embedding cache builder (~26 min on CPU)
    ├── run.ts             # evaluation → results/results.json
    ├── report.ts          # → results/waiter-longmemeval-report.pdf
    ├── data/              # gitignored: downloaded dataset (277 MB)
    ├── cache/             # gitignored: embeddings + query embeddings
    └── results/           # results.json + PDF (committed)
```

**Keep the HTTP layer and the retrieval layer separate.** Routes go in `src/index.ts` (or `src/routes/*` once it grows); anything about ranking, scoring or indexing goes in `src/store.ts`. The benchmark imports `MemoryStore` directly, so moving ranking logic into route handlers silently un-benchmarks it.

---

## 3. Run it

```bash
cd waiter
npm install
npm run dev        # tsx src/index.ts, :3000
npm run build      # tsc → dist/
npm start          # node dist/index.js
npm test           # vitest run
npx tsc -p tsconfig.check.json   # typecheck src + bench + test
```

- Port: `PORT` if it is a positive number, otherwise **3000**. Note that many shells export `PORT=""` or `PORT=0`; both must fall back to 3000, not to a random port.
- Env: optional `.env` via `dotenv`.
- Health: `GET /health` → `{ status, uptime, memories }`.
- **No watch mode.** Restart after edits.

---

## 4. API contract (implemented)

All bodies and responses are JSON.

### `GET /health`
→ `200 { "status": "ok", "uptime": number, "memories": number }`

### `GET /stats`
→ `200 { memories, users, documents, byUser: { [userId]: count } }`

### `POST /users`
Body: `{ "id": string, "name"?: string, "email"?: string }`
→ `201 { "id": string, "message": "User created" }` · `400` when `id` missing.
*No uniqueness check — POSTing the same id overwrites.*

### `GET /users/:id`
→ `200 { id, name?, email?, createdAt }` · `404 { "error": "User not found" }`

### `POST /memories`
Body: `{ userId, content, metadata?, embedding?, id? }`
→ `201 Memory`
```json
{
  "id": "uuid-v4",
  "userId": "user_123",
  "content": "Prefers TypeScript",
  "metadata": {},
  "createdAt": "2026-10-26T10:59:16.381Z"
}
```
→ `400 { "error": "userId and content are required" }`

`embedding` is **now used for ranking** by `vectorSearch` / `hybridSearch`. Omitting it means that memory is invisible to the dense side but still fully searchable by BM25. Supplying `id` makes the write idempotent (upsert) — document chunks rely on this.

### `GET /memories?userId=&q=&mode=&limit=`
- No `q` → list memories for `userId` (or all), capped by `limit` (default 100, max 500).
- `q` + `mode=keyword` → v1 behaviour: case-insensitive **substring** match, insertion order, plain memory objects returned.
- `q` + `mode=bm25` (**default**) → ranked BM25 hits, each memory object plus `score`.
- `q` without `userId` → substring filter across all users (v1 compatibility).

### `GET /memories/:id`
→ `200 Memory` · `404 { "error": "Memory not found" }`

### `POST /search`
Body: `{ userId, query, embedding?, limit?, recencyWeight?, rrfK? }`
→ `200 { query, mode: "hybrid"|"bm25", count, results: [{ id, userId, content, metadata, score, sources }] }`
- Hybrid when `embedding` is supplied, BM25 otherwise.
- `sources` says which retriever contributed (`["bm25","vector"]`) — useful for debugging rank order.
- `recencyWeight` defaults to **off (0)** deliberately; it measurably hurt on LongMemEval (see README §2.6).

### `POST /documents`
Body: `{ userId, content, metadata?, id? }`
→ `201 Document` where `chunks` is paragraph-split (`/\n{2,}/`), each paragraph hard-split at 800 chars. Every chunk is stored as a memory with id `${docId}::chunk_${i}` and `metadata.documentId`.
→ `400` when `userId`/`content` missing.

### `GET /documents/:id`
→ `200 Document` · `404 { "error": "Document not found" }`

**There is no `GET /documents` list endpoint.** Add it if a task needs it.

### Error envelope
Every error is `{ "error": "<message>" }`. Unhandled exceptions → `500 { "error": "Internal server error" }`.

---

## 5. Retrieval internals (`src/store.ts`)

| Function | Behaviour |
|---|---|
| `keywordSearch(userId, query, limit)` | Exact substring, insertion order, score 1. Kept for v1 callers. |
| `bm25Search(userId, query, limit, {k1,b})` | Okapi BM25, k1=1.2, b=0.75, over an inverted index built lazily per user. |
| `vectorSearch(userId, queryEmbedding, limit)` | Cosine similarity; skips memories with no vector. |
| `hybridSearch({...})` | RRF over `bm25Search` + `vectorSearch` (rrfK=60), optional recency decay. |
| `tokenize` / `stem` | Lowercase, stopwords (including question words), plural-only stemming. |

Things that will bite you:

- **The BM25 index is invalidated by every write** (`indexDirty`), and rebuilt on the next query for that user. Correct, but O(corpus) per write-then-query cycle. Persistence + incremental indexing is a real task, not a refactor.
- **Stemming is deliberately plural-only.** Stripping `-ed`/`-ing` without a lexicon creates *new* mismatches ("named" → "nam" ≠ "name"). Do not "upgrade" it to Porter without re-running the benchmark.
- **`hybridSearch` re-runs both retrievers each call.** Query expansion doubles that; measured cost was ~30x latency for a 0.1-point gain.
- **Scores are not comparable across modes.** BM25 scores are unbounded; RRF scores are ~1/60 per retriever. Never threshold a `score` without knowing the mode.

---

## 6. Storage semantics (critical)

- **Non-durable.** All data is lost on process exit. Never describe this service as persistent.
- **Not multi-process safe.** Deploy single-instance only.
- **No auth or tenancy enforcement.** `userId` is a **filter string, not a security boundary** — any caller can read any scope. Do not claim isolation.
- **No pagination** beyond the `limit` cap; `GET /memories` without `q` returns an unordered slice.

If a task needs durability, put a repository interface in front of the Maps (`src/store.ts`) and implement it with SQLite/Postgres. Do not import SQL into route handlers.

---

## 7. Conventions

- **Language:** TypeScript, ESM (`"type": "module"`). `tsx` resolves extensionless imports at dev time; the compiled build needs explicit `.js` specifiers, so use them (`from "./store.js"`) as the existing files do.
- **Types:** `strict: true`. Do not add `any` to silence errors; the `err: any` in the error middleware is the only intentional one.
- **Routes:** flat `app.get/app.post` in `src/index.ts`; small handler bodies; response shapes documented above must not change silently.
- **IDs:** `uuidv4()` unless an id is supplied for idempotency.
- **Timestamps:** ISO 8601 via `new Date().toISOString()`.
- **Field names:** camelCase. Do not introduce `container_tag`/`containerTag` — that is Supermemory's vocabulary.
- **Errors:** `res.status(n).json({ error: "..." })`. Never return HTML.

---

## 8. Benchmarking rules

- The harness must keep importing `MemoryStore` directly. If you change retrieval, re-run `npx tsx bench/run.ts` (embeddings are cached; ~2 minutes) and regenerate the PDF.
- **Never tune on the test split.** `splitOf()` hashes question ids 70/30; dev tunes, test reports. Keep it that way.
- **Report Recall@1 / MRR, not just Recall@20.** On this split there are ~48 sessions per question, so Recall@20 is saturated (BM25 alone gets 97.8%) and cannot distinguish systems. This is the single most misleading number available.
- **Single-digit deltas at n=365 are noise.** ±3.3 points at rank 1. Say "within the confidence interval" unless it is not.
- **Do not put a QA-accuracy number in any table** without running an answerer + judge. Waiter has none.

---

## 9. Testing

- Vitest (`npm test`). Specs live in `test/`, included by `tsconfig.json`.
- `test/store.test.ts` covers stemming, keyword/BM25/vector/hybrid ranking, user isolation, index invalidation, and cosine edge cases. Extend it when you change `store.ts`.
- For HTTP tests, prefer `supertest` against the exported `app` over spawning a process.
- Do not assert on `uptime` values or exact UUIDs.
- Typecheck everything (bench and tests included): `npx tsc -p tsconfig.check.json`. `tsconfig.json` only covers `src/` because `rootDir` is `src/`.

---

## 10. Known gaps / honest status

| Capability | Status |
|---|---|
| Add/get/list memories | ✅ working |
| Ranked retrieval (BM25, vector, RRF hybrid) | ✅ working, measured (README §2.6) |
| Paragraph-aware document chunking | ✅ working |
| Retrieval benchmark + PDF report | ✅ `bench/`, committed results |
| Automated tests | ✅ `test/store.test.ts` (11 tests) |
| Users CRUD | ⚠️ create + read only |
| Persistence | ❌ in-memory only |
| Embeddings generated | ❌ caller supplies them |
| Chunk-level retrieval with session aggregation | ❌ one vector per memory |
| ANN index | ❌ brute-force cosine |
| Cross-encoder reranker | ❌ RRF fusion only |
| Fact extraction from conversations | ❌ none |
| User profile synthesis | ❌ none |
| Knowledge update / contradiction handling | ❌ none (recency prior measured and disabled) |
| Document extraction (PDF/OCR/video) | ❌ none |
| Connectors (Drive/Gmail/Notion) | ❌ none |
| Auth / tenancy enforcement | ❌ none |
| Rate limiting, pagination | ❌ none |
| QA accuracy on LongMemEval | ❌ not measured, do not claim |

---

## 11. Hard constraints — do not violate

- **Do not** copy code from Supermemory's proprietary self-hosted binary or any non-MIT source. Every dependency must be MIT/Apache-2.0/BSD compatible.
- **Do not** add AGPL dependencies without explicit user approval — it creates source-disclosure obligations.
- **Do not** rename the project or the memory concept; the project is **Waiter**.
- **Do not** touch or merge with the **tanu** project. They stay separate in this phase.
- **Do not** claim persistence, isolation, semantic parity, or benchmark parity the code does not implement. Quote README §2.6 with its caveats or not at all.
- **Do not** commit secrets, `bench/data/`, `bench/cache/`, or `bench/models/` (all gitignored).

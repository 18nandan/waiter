import express, { Request, Response, NextFunction } from "express";
import "dotenv/config";
import { store } from "./store.js";

const app = express();
app.use(express.json({ limit: "25mb" }));

// `PORT` is often present but blank or "0" (CI shells, some IDE terminals), and
// Number() turns both into 0, which silently binds a random port. Treat any
// non-positive/non-numeric value as unset.
const envPort = Number(process.env.PORT);
const PORT = Number.isFinite(envPort) && envPort > 0 ? envPort : 3000;

// ============================
// Users
// ============================

const users = new Map<string, { id: string; name?: string; email?: string; createdAt: string }>();

app.get("/users/:id", (req: Request, res: Response) => {
  const user = users.get(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json(user);
});

app.post("/users", (req: Request, res: Response) => {
  const { id, name, email } = req.body ?? {};
  if (!id) return res.status(400).json({ error: "User ID required" });
  users.set(id, { id, name, email, createdAt: new Date().toISOString() });
  res.status(201).json({ id, message: "User created" });
});

// ============================
// Memories
// ============================

app.post("/memories", (req: Request, res: Response) => {
  const { userId, content, metadata, embedding, id } = req.body ?? {};
  if (!userId || !content) {
    return res.status(400).json({ error: "userId and content are required" });
  }
  const memory = store.add({ userId, content, metadata, embedding, id });
  res.status(201).json(memory);
});

app.get("/memories/:id", (req: Request, res: Response) => {
  const memory = store.get(req.params.id);
  if (!memory) return res.status(404).json({ error: "Memory not found" });
  res.json(memory);
});

/**
 * List memories for a user.
 *   ?userId=&limit=&q=&mode=keyword|bm25
 * `mode=keyword` is the v1 exact-substring behaviour; `bm25` (default) ranks.
 */
app.get("/memories", (req: Request, res: Response) => {
  const { userId, q, mode = "bm25", limit } = req.query as Record<string, string | undefined>;
  const take = limit ? Math.max(1, Math.min(500, Number(limit))) : 100;

  if (!q) {
    return res.json(store.list({ userId }).slice(0, take));
  }
  if (!userId) {
    // Keyword filtering across all users, as in v1.
    return res.json(store.list({ q }).slice(0, take));
  }

  const hits =
    mode === "keyword"
      ? store.keywordSearch(userId, q, take)
      : store.bm25Search(userId, q, take);

  // Without a ranking model, keyword hits carry score 1; return plain objects
  // there so v1 callers keep seeing the same shape.
  if (mode === "keyword") return res.json(hits.map((h) => h.memory));
  res.json(hits.map((h) => ({ ...h.memory, score: h.score })));
});

/**
 * Explicit retrieval endpoint. Hybrid search when an embedding is supplied,
 * BM25 when it is not.
 */
app.post("/search", (req: Request, res: Response) => {
  const { userId, query, embedding, limit, recencyWeight, rrfK } = req.body ?? {};
  if (!userId || !query) {
    return res.status(400).json({ error: "userId and query are required" });
  }
  const hits = store.hybridSearch({
    userId,
    query,
    queryEmbedding: Array.isArray(embedding) && embedding.length ? embedding : undefined,
    limit: limit ?? 10,
    recencyWeight,
    rrfK,
  });
  res.json({
    query,
    mode: Array.isArray(embedding) && embedding.length ? "hybrid" : "bm25",
    count: hits.length,
    results: hits.map((h) => ({
      id: h.memory.id,
      userId: h.memory.userId,
      content: h.memory.content,
      metadata: h.memory.metadata,
      score: h.score,
      sources: h.sources,
    })),
  });
});

// ============================
// Documents
// ============================

const documents = new Map<string, any>();

app.post("/documents", (req: Request, res: Response) => {
  const { userId, content, metadata, id } = req.body ?? {};
  if (!userId || !content) {
    return res.status(400).json({ error: "userId and content are required" });
  }
  const docId = id ?? `doc_${Math.random().toString(36).slice(2, 10)}`;
  const text: string = content;

  // Chunk on paragraph boundaries, then hard-split paragraphs that are too
  // long. Chunks are the retrieval unit; they keep their parent doc id.
  const chunks: string[] = [];
  for (const para of text.split(/\n{2,}/)) {
    if (para.length <= 800) {
      if (para.trim()) chunks.push(para.trim());
    } else {
      for (let i = 0; i < para.length; i += 800) chunks.push(para.slice(i, i + 800).trim());
    }
  }

  for (let i = 0; i < chunks.length; i++) {
    store.add({
      id: `${docId}::chunk_${i}`,
      userId,
      content: chunks[i],
      metadata: { ...(metadata ?? {}), documentId: docId, chunkIndex: i, kind: "chunk" },
    });
  }

  const document = {
    id: docId,
    userId,
    content,
    metadata: metadata ?? {},
    chunks,
    chunkIds: chunks.map((_, i) => `${docId}::chunk_${i}`),
    createdAt: new Date().toISOString(),
  };
  documents.set(docId, document);
  res.status(201).json(document);
});

app.get("/documents/:id", (req: Request, res: Response) => {
  const doc = documents.get(req.params.id);
  if (!doc) return res.status(404).json({ error: "Document not found" });
  res.json(doc);
});

// ============================
// Health + stats
// ============================

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", uptime: process.uptime(), memories: store.size });
});

app.get("/stats", (_req: Request, res: Response) => {
  const byUser: Record<string, number> = {};
  for (const m of store.list()) byUser[m.userId] = (byUser[m.userId] ?? 0) + 1;
  res.json({ memories: store.size, users: Object.keys(byUser).length, documents: documents.size, byUser });
});

// ============================
// Errors
// ============================

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

const server = app.listen(PORT, () => {
  console.log(`🧠 Waiter running at http://localhost:${PORT}`);
  console.log("MIT-licensed self-hosted memory API — memory layer, no LLM baked in");
});

export { app, server };
export default app;

/**
 * Pre-computes MiniLM embeddings for LongMemEval haystack sessions and writes
 * them to an on-disk cache keyed by content hash, so the benchmark can be
 * re-run (and re-scored with new retrieval settings) without re-embedding.
 *
 *   node --experimental-strip-types bench/embed.ts
 *
 * Embedding cost on CPU is the bottleneck (~54ms/text on the dev machine), so
 * this runs as a separate, resumable pass.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline, env } from "@xenova/transformers";

const ROOT = path.resolve(import.meta.dirname ?? ".");
const DATA = path.join(ROOT, "data");
const CACHE = path.join(ROOT, "cache");
const BIN = path.join(CACHE, "embeddings.bin");
const INDEX = path.join(CACHE, "embeddings.index.json");
const DIM = 384;
const BATCH = 16;
const MAX_CHARS = 1100;

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

export function sha1(s: string): string {
  return crypto.createHash("sha1").update(s).digest("hex");
}

/**
 * A session is ~2.5k tokens but MiniLM reads 256 word pieces, so embedding the
 * raw transcript would silently discard most of it. User turns carry the facts
 * in LongMemEval assistant turns are mostly boilerplate, so the digest is the
 * user utterances joined together, capped at ~1.1k characters.
 */
export function sessionDigest(turns: Turn[]): string {
  const userText = turns.filter((t) => t.role === "user").map((t) => t.content.trim()).join(" ");
  const fallback = turns.map((t) => t.content.trim()).join(" ");
  return (userText || fallback).slice(0, MAX_CHARS);
}

export function loadDataset(split = "longmemeval_s_cleaned.json"): Question[] {
  return JSON.parse(fs.readFileSync(path.join(DATA, split), "utf8")) as Question[];
}

async function main() {
  fs.mkdirSync(CACHE, { recursive: true });
  const questions = loadDataset();

  // Collect the unique digests we need.
  const digestByHash = new Map<string, string>();
  for (const q of questions) {
    for (const turns of q.haystack_sessions) {
      const digest = sessionDigest(turns);
      if (!digest) continue;
      digestByHash.set(sha1(digest), digest);
    }
  }
  console.log(`unique session digests: ${digestByHash.size}`);

  // Load existing cache.
  const index: Record<string, number> = fs.existsSync(INDEX)
    ? JSON.parse(fs.readFileSync(INDEX, "utf8"))
    : {};
  const existingRows = Object.keys(index).length;
  console.log(`cached embeddings: ${existingRows}`);

  const pending = [...digestByHash.entries()].filter(([h]) => index[h] === undefined);
  console.log(`to embed: ${pending.length}`);
  if (pending.length === 0) {
    console.log("cache complete");
    return;
  }

  const extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
    quantized: true,
  });

  const bin = fs.existsSync(BIN) ? fs.openSync(BIN, "a") : fs.openSync(BIN, "w");
  const started = Date.now();
  let done = 0;

  for (let i = 0; i < pending.length; i += BATCH) {
    const slice = pending.slice(i, i + BATCH);
    const out = await extractor(
      slice.map(([, text]) => text),
      { pooling: "mean", normalize: true },
    );
    const data = out.data as Float32Array;
    const rows = slice.length;
    for (let r = 0; r < rows; r++) {
      const vec = data.subarray(r * DIM, (r + 1) * DIM);
      const nextRow = Object.keys(index).length;
      fs.writeSync(bin, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength));
      index[slice[r][0]] = nextRow;
    }
    done += rows;

    if (done % 1600 < BATCH) {
      fs.writeFileSync(INDEX, JSON.stringify(index));
      const elapsed = (Date.now() - started) / 1000;
      const rate = done / elapsed;
      const eta = (pending.length - done) / rate;
      console.log(
        `${done}/${pending.length} embedded | ${rate.toFixed(1)}/s | eta ${(eta / 60).toFixed(1)} min`,
      );
    }
  }

  fs.closeSync(bin);
  fs.writeFileSync(INDEX, JSON.stringify(index));
  console.log(`done: ${Object.keys(index).length} vectors in ${((Date.now() - started) / 60000).toFixed(1)} min`);
}

if (import.meta.url === `file://${process.argv[1]}`.replace(/\\/g, "/") || process.argv[1]?.endsWith("embed.ts")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

/**
 * Renders results/results.json into a PDF report with bar charts.
 *
 *   npx tsx bench/report.ts
 */
import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";

const ROOT = path.resolve(import.meta.dirname ?? ".");
const OUT = path.join(ROOT, "results");
const results = JSON.parse(fs.readFileSync(path.join(OUT, "results.json"), "utf8"));

const INK = "#0f172a";
const MUTED = "#64748b";
const GRID = "#e2e8f0";
const ACCENTS: Record<string, string> = {
  "keyword-v1": "#94a3b8",
  bm25: "#2563eb",
  vector: "#0d9488",
  hybrid: "#7c3aed",
  "hybrid+exp": "#db2777",
  supermemory: "#f97316",
  full: "#0f172a",
};
const LATENCY_NOTE: Record<string, string> = {
  "keyword-v1": "substring scan over every memory, no ranking",
  bm25: "inverted index, BM25 scoring (warm)",
  vector: "brute-force cosine over the user's vectors",
  hybrid: "BM25 + vector + RRF fusion",
  "hybrid+exp": "hybrid, run twice (expansion adds a second pass)",
};
const CONFIGS = ["keyword-v1", "bm25", "vector", "hybrid", "hybrid+exp"];
const PRETTY: Record<string, string> = {
  "keyword-v1": "v1 keyword",
  bm25: "BM25",
  vector: "Vector (MiniLM)",
  hybrid: "Hybrid RRF",
  "hybrid+exp": "Hybrid + expansion",
};
/** Short labels for legends, which have ~95pt each before they collide. */
const SHORT: Record<string, string> = {
  "keyword-v1": "v1",
  bm25: "BM25",
  vector: "Vector",
  hybrid: "Hybrid",
  "hybrid+exp": "Hybrid+exp",
};
/**
 * What each question type actually showed in this run. Written out per type
 * rather than inferred, because a heuristic on the numbers mislabelled the
 * assistant and preference categories.
 */
const TYPE_READ: Record<string, string> = {
  "single-session-user": "lexical: named entities match verbatim",
  "single-session-assistant": "lexical: digest misses assistant turns",
  "single-session-preference": "dense: implicit, no shared vocabulary",
  "multi-session": "fusion: needs several evidence sessions",
  "temporal-reasoning": "weak for every retriever",
  "knowledge-update": "lexical: updated fact keeps its wording",
};

const doc = new PDFDocument({ size: "A4", margin: 46, bufferPages: true });
const pdfPath = path.join(OUT, "waiter-longmemeval-report.pdf");
doc.pipe(fs.createWriteStream(pdfPath));

const W = doc.page.width - 92;
const L = 46;
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const pctCI = (m: any) => `${(m.mean * 100).toFixed(1)}% ±${(m.ci95 * 100).toFixed(1)}`;

function h1(text: string) {
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(21).text(text, L, doc.y);
  doc.moveDown(0.2);
}
function h2(text: string) {
  ensure(30);
  doc.moveDown(0.85);
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(12.4).text(text, L, doc.y);
  doc.moveDown(0.3);
  doc.fillColor(INK).font("Helvetica").fontSize(9.4);
}
function body(text: string, opts: { color?: string; size?: number } = {}) {
  doc
    .fillColor(opts.color ?? "#334155")
    .font("Helvetica")
    .fontSize(opts.size ?? 9.4)
    .text(text, L, doc.y, { width: W, align: "left", lineGap: 1.6 });
  doc.moveDown(0.35);
}
function ensure(h: number) {
  if (doc.y + h > doc.page.height - 60) doc.addPage();
}
function rule() {
  doc.moveDown(0.4);
  doc.strokeColor(GRID).lineWidth(1).moveTo(L, doc.y).lineTo(L + W, doc.y).stroke();
  doc.moveDown(0.5);
}

interface BarGroup {
  label: string;
  values: { key: string; value: number }[];
}

function groupedBars(opts: {
  groups: BarGroup[];
  height?: number;
  max?: number;
  title?: string;
  fmt?: (v: number) => string;
  legend?: string[];
}) {
  const groups = opts.groups;
  const h = opts.height ?? 160;
  const fmt = opts.fmt ?? pct;
  const max = opts.max ?? Math.max(...groups.flatMap((g) => g.values.map((v) => v.value)), 0.0001) * 1.15;
  ensure(h + 58);
  if (opts.title) {
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(10).text(opts.title, L, doc.y);
    doc.moveDown(0.5);
  }
  const top = doc.y;
  const left = L + 38;
  const plotW = W - 38;
  const plotH = h - 26;

  doc.strokeColor(GRID).lineWidth(0.7);
  for (let i = 0; i <= 4; i++) {
    const y = top + (plotH / 4) * i;
    doc.moveTo(left, y).lineTo(left + plotW, y).stroke();
    doc
      .fillColor(MUTED)
      .font("Helvetica")
      .fontSize(6.5)
      .text(fmt(max - (max / 4) * i), L - 2, y - 3, { width: 36, align: "right" });
  }

  const gw = plotW / groups.length;
  const nPer = groups[0].values.length;
  const bw = Math.min(26, (gw * 0.7) / nPer);

  groups.forEach((g, gi) => {
    const gx = left + gi * gw;
    const totalW = bw * nPer;
    g.values.forEach((v, vi) => {
      const bh = Math.max(0, (v.value / max) * plotH);
      const bx = gx + (gw - totalW) / 2 + vi * bw;
      doc.fillColor(ACCENTS[v.key] ?? INK).rect(bx, top + plotH - bh, bw - 2, bh).fill();
      // Keep the value label inside the plot even when the bar is ~0 tall,
      // otherwise it lands on the axis and collides with the category label.
      const labelY = Math.min(top + plotH - bh - 8, top + plotH - 10);
      doc
        .fillColor(MUTED)
        .font("Helvetica")
        .fontSize(5.8)
        .text(fmt(v.value), bx - 4, labelY, { width: bw + 6, align: "center" });
    });
    doc
      .fillColor(INK)
      .font("Helvetica")
      .fontSize(6.8)
      .text(g.label, gx, top + plotH + 4, { width: gw, align: "center" });
  });

  doc.y = top + h + 10;

  if (opts.legend) {
    let lx = L;
    const ly = doc.y;
    for (const key of opts.legend) {
      doc.fillColor(ACCENTS[key] ?? INK).rect(lx, ly + 1, 7, 7).fill();
      doc
        .fillColor(MUTED)
        .font("Helvetica")
        .fontSize(7)
        .text(SHORT[key] ?? key, lx + 10, ly, { width: 84 });
      lx += 96;
    }
    doc.y = ly + 14;
  }
  doc.fillColor(INK).font("Helvetica").fontSize(9.4);
}

function lineChart(opts: {
  series: { key: string; points: number[] }[];
  xLabels: string[];
  title?: string;
  height?: number;
}) {
  const h = opts.height ?? 150;
  ensure(h + 56);
  if (opts.title) {
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(10).text(opts.title, L, doc.y);
    doc.moveDown(0.5);
  }
  const top = doc.y;
  const left = L + 38;
  const plotW = W - 38;
  const plotH = h - 26;
  const peak = Math.max(...opts.series.flatMap((s) => s.points));
  // Percentages should not produce an axis that reads 109%.
  const max = peak <= 1 ? 1 : peak * 1.1;

  doc.strokeColor(GRID).lineWidth(0.7);
  for (let i = 0; i <= 4; i++) {
    const y = top + (plotH / 4) * i;
    doc.moveTo(left, y).lineTo(left + plotW, y).stroke();
    doc
      .fillColor(MUTED)
      .font("Helvetica")
      .fontSize(6.5)
      .text(pct(max - (max / 4) * i), L - 2, y - 3, { width: 34, align: "right" });
  }

  const stepX = plotW / Math.max(1, opts.xLabels.length - 1);
  for (const s of opts.series) {
    const color = ACCENTS[s.key] ?? INK;
    s.points.forEach((v, i) => {
      const x = left + i * stepX;
      const y = top + plotH - (v / max) * plotH;
      if (i > 0) {
        const px = left + (i - 1) * stepX;
        const py = top + plotH - (s.points[i - 1] / max) * plotH;
        doc.strokeColor(color).lineWidth(1.4).moveTo(px, py).lineTo(x, y).stroke();
      }
      doc.fillColor(color).circle(x, y, 2.3).fill();
    });
  }
  opts.xLabels.forEach((lab, i) => {
    doc
      .fillColor(INK)
      .font("Helvetica")
      .fontSize(7)
      .text(lab, left + i * stepX - 18, top + plotH + 4, { width: 36, align: "center" });
  });
  doc.y = top + h + 12;
  doc.fillColor(INK).font("Helvetica").fontSize(9.4);
}

function table(opts: {
  headers: string[];
  rows: string[][];
  widths: number[];
  title?: string;
  align?: ("left" | "right" | "center")[];
  fontSize?: number;
}) {
  const fs2 = opts.fontSize ?? 7.6;
  ensure(30);
  if (opts.title) {
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(10).text(opts.title, L, doc.y);
    doc.moveDown(0.45);
  }
  const rowHeight = (cells: string[], bold: boolean) => {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(fs2);
    const needed = cells.map((cell, i) =>
      doc.heightOfString(cell, { width: opts.widths[i] - 4, align: opts.align?.[i] ?? "left" }),
    );
    return Math.max(15, Math.max(...needed) + 6);
  };

  // A table that fits on a blank page but not on this one should move whole,
  // rather than leaving one orphan row behind.
  const totalH = opts.rows.reduce((sum, r) => sum + rowHeight(r, false), rowHeight(opts.headers, true));
  const pageBottom = doc.page.height - 60;
  if (doc.y + totalH > pageBottom && totalH < doc.page.height - 150) doc.addPage();

  const drawRow = (cells: string[], bold: boolean, fill?: string) => {
    const rowH = rowHeight(cells, bold);
    if (doc.y + rowH > pageBottom) doc.addPage();
    const y = doc.y;
    if (fill) doc.fillColor(fill).rect(L, y - 2, W, rowH).fill();
    let x = L;
    cells.forEach((cell, i) => {
      doc
        .fillColor(bold ? INK : "#334155")
        .font(bold ? "Helvetica-Bold" : "Helvetica")
        .fontSize(fs2)
        .text(cell, x + 2, y + 2, {
          width: opts.widths[i] - 4,
          align: opts.align?.[i] ?? "left",
        });
      x += opts.widths[i];
    });
    doc.y = y + rowH;
  };
  drawRow(opts.headers, true, "#f1f5f9");
  opts.rows.forEach((r, i) => drawRow(r, false, i % 2 ? "#fafafa" : undefined));
  doc.moveDown(0.4);
  doc.fillColor(INK).font("Helvetica").fontSize(9.4);
}

function bullets(items: string[]) {
  for (const item of items) {
    ensure(24);
    doc.fillColor(INK).font("Helvetica").fontSize(9.4).text("\u2022", L + 2, doc.y);
    doc
      .fillColor("#334155")
      .font("Helvetica")
      .fontSize(9.3)
      .text(item, L + 14, doc.y - 9.6, { width: W - 14, lineGap: 1.4 });
    doc.moveDown(0.22);
  }
  doc.moveDown(0.25);
}

// ---------------------------------------------------------------- content

const cfg = results.configs;
const N = results.questionsEvaluated;
const best = "hybrid";
ACCENTS.waiter = ACCENTS[best];

const r1Of = (c: string) => cfg[c]["recall@1"].mean;
const r20Of = (c: string) => cfg[c]["recall@20"].mean;
const v1 = r1Of("keyword-v1");
const bestR1 = r1Of(best);
const bestR20 = r20Of(best);
const diff = (a: string, b: string) => cfg[a]["recall@1"].mean - cfg[b]["recall@1"].mean;
const combinedCI = (a: string, b: string) => cfg[a]["recall@1"].ci95 + cfg[b]["recall@1"].ci95;
const significant = (a: string, b: string) => Math.abs(diff(a, b)) > combinedCI(a, b) / 2;

const types = Object.keys(results.perType);
const typeCounts: Record<string, number> = {};
for (const [t, v] of Object.entries(results.perType) as [string, any][]) typeCounts[t] = v.bm25.n;

// ---- cover
doc.fillColor("#f8fafc").rect(0, 0, doc.page.width, 190).fill();
doc.fillColor("#2563eb").rect(0, 0, doc.page.width, 6).fill();
doc.fillColor(INK).font("Helvetica-Bold").fontSize(26).text("Waiter", L, 54);
doc.fillColor(MUTED).font("Helvetica").fontSize(13).text("LongMemEval-S retrieval report", L, 88);
doc
  .fillColor("#334155")
  .font("Helvetica")
  .fontSize(9.5)
  .text(
    `${N} held-out questions · all-MiniLM-L6-v2 embeddings · local CPU only · no LLM answerer or judge`,
    L,
    110,
    { width: W },
  );
doc
  .fillColor(MUTED)
  .font("Helvetica")
  .fontSize(8.5)
  .text(`Generated ${new Date().toISOString().slice(0, 10)} · dataset: xiaowu0162/longmemeval-cleaned (S split)`, L, 140, {
    width: W,
  });
doc
  .fillColor(MUTED)
  .font("Helvetica")
  .fontSize(7.5)
  .text("Waiter results are retrieval-only; Supermemory figures are vendor-published and not a matched head-to-head run.", L, 158, {
    width: W,
  });
doc.y = 210;

h2("Headline");
doc.fillColor(INK).font("Helvetica-Bold").fontSize(15).text(pct(bestR1), L, doc.y, { continued: true });
doc
  .fillColor(MUTED)
  .font("Helvetica")
  .fontSize(10)
  .text(`  Recall@1 for ${PRETTY[best]} — up from `, { continued: true });
doc.fillColor(INK).font("Helvetica-Bold").fontSize(15).text(pct(v1), { continued: true });
doc.fillColor(MUTED).font("Helvetica").fontSize(10).text(" with the v1 keyword retriever.");
doc.moveDown(0.5);

groupedBars({
  groups: [{ label: "Recall@1", values: CONFIGS.map((c) => ({ key: c, value: r1Of(c) })) }],
  height: 130,
  max: 1,
  legend: CONFIGS,
});

body(
  `Every question ships with ~${results.datasetTokens.toLocaleString()} tokens of history. ` +
    `${PRETTY[best]} puts an evidence session at rank 1 for ${pct(bestR1)} of questions while reading ` +
    `${cfg[best].tokens.top5.toLocaleString()} tokens into a prompt — ${((cfg[best].tokens.top5 / results.datasetTokens) * 100).toFixed(0)}% of the history.`,
);

doc.moveDown(0.2);
const boxY = doc.y;
const boxText =
  `Retrieval went from broken to usable: Recall@1 ${pct(v1)} to ${pct(bestR1)}, MRR@20 ${pct(cfg["keyword-v1"]["mrr@20"].mean)} to ${pct(cfg[best]["mrr@20"].mean)}. ` +
  `Recall@20 is already ${pct(r20Of("bm25"))} with plain BM25, because this split only has ~48 sessions per question; it has little power to distinguish systems here. ` +
  `The honest read: Waiter now retrieves well for a lexical-first system, embeddings help most on preference questions, and answer quality was not measured. This report does not show that Waiter beats Supermemory.`;
doc.font("Helvetica").fontSize(8.6);
const boxH = doc.heightOfString(boxText, { width: W - 28, lineGap: 1.5 }) + 34;
doc.fillColor("#f1f5f9").rect(L, boxY, W, boxH).fill();
doc.fillColor("#2563eb").rect(L, boxY, 3, boxH).fill();
doc.fillColor(INK).font("Helvetica-Bold").fontSize(9).text("Verdict", L + 14, boxY + 11);
doc.fillColor("#334155").font("Helvetica").fontSize(8.6).text(boxText, L + 14, boxY + 27, { width: W - 28, lineGap: 1.5 });
doc.y = boxY + boxH + 10;

// ---- methodology
doc.addPage();
h1("1. What was measured, and what was not");
body(
  "LongMemEval has two halves. The retrieval half asks whether the right sessions come back for a question. " +
    "The QA half feeds those sessions to a model and has a judge score the answer. This report covers the first half only.",
);
table({
  headers: ["Component", "Status here", "Why"],
  widths: [150, 105, W - 255],
  rows: [
    ["Retrieval (Recall@k, NDCG, MRR)", "Measured, this report", "Runs entirely locally on CPU. No credentials needed."],
    [
      "QA accuracy (LLM answer + judge)",
      "Not run",
      "Needs an answerer model and an LLM judge with API access. Neither is available here, so no accuracy number is claimed.",
    ],
    ["Token cost", "Measured", "Character counts of retrieved sessions / 4, against full history."],
  ],
});

h2("Benchmark configuration");
bullets([
  `Dataset: xiaowu0162/longmemeval-cleaned, split longmemeval_s_cleaned.json — 500 questions, 23,867 haystack sessions, ~${results.datasetTokens.toLocaleString()} tokens of history per question.`,
  "Corpus per question: one memory per haystack session, scoped by userId = question_id. LongMemEval labels evidence at session level, so the session is the retrieval unit.",
  "Relevance: a retrieved session counts only if its id is in answer_session_ids.",
  `Split: 70/30 by question-id hash. ${results.devQuestions} dev questions tuned the recency weight; the ${N} test questions are reported and were never used for tuning.`,
  "Embeddings: Xenova/all-MiniLM-L6-v2 (384-dim, quantised, mean-pooled, L2-normalised) on local CPU. Each session is embedded as a digest of its user turns, capped at 1,100 characters, because MiniLM reads 256 tokens and a session is ~2.5k.",
  "BM25 indexes the full session transcript, so the lexical side sees text the dense side cannot. That asymmetry is a property of the models, not a tuning choice, and it matters for the assistant-turn questions below.",
]);

h2("Metrics");
table({
  headers: ["Metric", "Definition"],
  widths: [80, W - 80],
  rows: [
    ["Recall@k", "Fraction of a question's evidence sessions present in the top k results."],
    ["NDCG@10", "Rank-aware gain, binary relevance, normalised by min(|evidence|, 10)."],
    ["MRR@20", "Reciprocal rank of the first evidence session found in the top 20."],
    ["Latency", "Warm in-process query time; the BM25 index is built before timing starts."],
    ["± figures", "95% confidence intervals across questions."],
  ],
});

// ---- results
doc.addPage();
h1("2. Retrieval results");
body(
  `Five retrievers, one corpus, ${N} questions, identical labels. Only ranking differs, so the deltas are attributable to retrieval.`,
);
table({
  headers: ["Configuration", "R@1 (95% CI)", "R@5", "R@10", "R@20 (95% CI)", "NDCG@10", "MRR@20", "ms"],
  widths: [100, 76, 42, 42, 76, 56, 56, W - 448],
  align: ["left", "right", "right", "right", "right", "right", "right", "right"],
  rows: CONFIGS.map((c) => [
    PRETTY[c],
    pctCI(cfg[c]["recall@1"]),
    pct(cfg[c]["recall@5"].mean),
    pct(cfg[c]["recall@10"].mean),
    pctCI(cfg[c]["recall@20"]),
    pct(cfg[c]["ndcg@10"].mean),
    pct(cfg[c]["mrr@20"].mean),
    cfg[c]["latency_ms"].p50.toFixed(2),
  ]),
});

h2("Recall@k curves");
lineChart({
  series: CONFIGS.map((c) => ({ key: c, points: [1, 3, 5, 10, 20].map((k) => cfg[c][`recall@${k}`].mean) })),
  xLabels: ["@1", "@3", "@5", "@10", "@20"],
  height: 160,
});
let lx = L;
for (const c of CONFIGS) {
  doc.fillColor(ACCENTS[c]).rect(lx, doc.y + 1, 7, 7).fill();
  doc.fillColor(MUTED).font("Helvetica").fontSize(6.9).text(SHORT[c], lx + 10, doc.y, { width: 84 });
  lx += 96;
}
doc.y += 16;
body(
  "The curves flatten hard after 5. Almost everything is recoverable by rank 20, which is why Recall@20 cannot separate these systems; rank 1 is where the differences live.",
  { size: 8.6, color: MUTED },
);

// The per-type chart and its table need a full page between them; breaking here
// keeps the table from splitting a single row onto the next page.
doc.addPage();
h2("Recall@1 by question type");
groupedBars({
  groups: types.map((t) => ({
    label: t
      .replace("single-session-", "ss-")
      .replace("multi-session", "multi")
      .replace("temporal-reasoning", "temporal")
      .replace("knowledge-update", "kn-upd")
      .replace("preference", "pref"),
    values: [
      { key: "bm25", value: results.perType[t].bm25.r1 },
      { key: "vector", value: results.perType[t].vector.r1 },
      { key: "hybrid", value: results.perType[t].hybrid.r1 },
    ],
  })),
  height: 168,
  max: 1,
  legend: ["bm25", "vector", "hybrid"],
});
table({
  headers: ["Question type", "n", "BM25 R@1", "Vector R@1", "Hybrid R@1", "Reads as"],
  widths: [104, 26, 58, 58, 58, W - 304],
  align: ["left", "right", "right", "right", "right", "left"],
  rows: types.map((t) => {
    const b = results.perType[t].bm25.r1;
    const v = results.perType[t].vector.r1;
    const h = results.perType[t].hybrid.r1;
    const read =
      (typeCounts[t] < 30 ? "small n, indicative only · " : "") + (TYPE_READ[t] ?? "");
    return [t.replace("single-session-", "ss-"), String(typeCounts[t]), pct(b), pct(v), pct(h), read];
  }),
});

// ---- comparison
doc.addPage();
h1("3. Comparison with Supermemory and the published baselines");
body(
  "The published numbers and the numbers here come from different harnesses, so they are shown side by side, not merged. " +
    "Supermemory reports Recall@20 with aggregation on LongMemEval-S; that is the one metric both can be measured on. " +
    "Every other published figure is QA accuracy under an LLM judge, which this report does not produce.",
);

h2("Recall@20 — the metric everyone headlines");
groupedBars({
  groups: [
    {
      label: "Recall@20",
      values: [
        { key: "supermemory", value: 0.97 },
        { key: "waiter", value: bestR20 },
        { key: "bm25", value: r20Of("bm25") },
      ],
    },
  ],
  height: 118,
  max: 1,
  legend: [],
});
let lx2 = L;
for (const [key, name] of [
  ["supermemory", "Supermemory (published)"],
  ["waiter", `Waiter ${SHORT[best]} (measured)`],
  ["bm25", "Waiter BM25 only"],
] as [string, string][]) {
  doc.fillColor(ACCENTS[key] ?? INK).rect(lx2, doc.y + 1, 7, 7).fill();
  doc.fillColor(MUTED).font("Helvetica").fontSize(6.8).text(name, lx2 + 10, doc.y, { width: 140 });
  lx2 += 150;
}
doc.y += 16;

body(
  `Waiter's Hybrid R@20 is ${pct(r20Of("hybrid"))} (${pct(r20Of("hybrid+exp"))} with query expansion); Supermemory's vendor-reported result is ${pct(0.97)}. This report has not reproduced Supermemory's aggregation/evaluation pipeline, so they are not a head-to-head win or parity result. ` +
    `Plain BM25 alone scores ${pct(r20Of("bm25"))} on Waiter's split. With roughly 48 sessions per question, top-20 covers over 40% of the corpus, making this metric weakly discriminative here. Treat any cross-system difference as inconclusive without matched protocols and per-question results. ` +
    "See the public Supermemory report at supermemory.ai/research/longmembench/.",
  { size: 8.8 },
);

h2("Where the retrievers actually differ");
groupedBars({
  groups: [
    {
      label: "Waiter (measured)",
      values: [
        { key: "keyword-v1", value: r1Of("keyword-v1") },
        { key: "bm25", value: r1Of("bm25") },
        { key: "vector", value: r1Of("vector") },
        { key: "hybrid", value: r1Of("hybrid") },
      ],
    },
  ],
  height: 118,
  max: 1,
  legend: [],
});
let lx3 = L;
for (const [key, name] of [
  ["keyword-v1", "v1 keyword"],
  ["bm25", "BM25"],
  ["vector", "Vector only"],
  ["hybrid", "Hybrid RRF"],
] as [string, string][]) {
  doc.fillColor(ACCENTS[key] ?? INK).rect(lx3, doc.y + 1, 7, 7).fill();
  doc.fillColor(MUTED).font("Helvetica").fontSize(6.8).text(name, lx3 + 10, doc.y, { width: 110 });
  lx3 += 114;
}
doc.y += 16;

h2("QA accuracy on LongMemEval-S (published, GPT-4o answerer and judge)");
table({
  headers: ["System", "Overall accuracy", "Source"],
  widths: [170, 95, W - 265],
  rows: [
    ["Supermemory + GPT-4o", "97.0%", "supermemory research report"],
    ["Supermemory + Gemini 3 Pro", "85.2%", "same report"],
    ["Supermemory + GPT-5", "84.6%", "same report"],
    ["Zep + GPT-4o", "71.2%", "same report"],
    ["Full context + GPT-4o", "60.2%", "same report"],
    ["Waiter", "not measured", "needs an answerer + judge with API access"],
  ],
});
body(
  "Waiter has no row with a number in it on purpose. It is storage and retrieval with no LLM inside, so its answer accuracy is whatever " +
    "model reads its output. Putting a figure there without running the harness would be fabrication.",
  { size: 8.6, color: MUTED },
);

// ---- cost
doc.addPage();
h1("4. Cost of answering a question");
h2("Tokens per question");
groupedBars({
  groups: [
    { label: "full history", values: [{ key: "full", value: results.datasetTokens }] },
    { label: "top 10", values: [{ key: "waiter", value: cfg[best].tokens.top10 }] },
    { label: "top 5", values: [{ key: "waiter", value: cfg[best].tokens.top5 }] },
  ],
  height: 140,
  max: results.datasetTokens * 1.15,
  fmt: (v) => Math.round(v).toLocaleString(),
});
body(
  `${PRETTY[best]} finds an evidence session at rank 1 for ${pct(bestR1)} of questions; reading the top 5 costs ` +
    `${cfg[best].tokens.top5.toLocaleString()} tokens instead of ${results.datasetTokens.toLocaleString()} — ` +
    `a ${(100 - (cfg[best].tokens.top5 / results.datasetTokens) * 100).toFixed(0)}% reduction in reading cost. ` +
    "That is the real product argument for retrieval here, more than the recall numbers.",
  { size: 8.8 },
);

h2("Latency (warm, in-process)");
table({
  headers: ["Configuration", "p50", "Mean", "Path"],
  widths: [110, 52, 52, W - 214],
  align: ["left", "right", "right", "left"],
  rows: CONFIGS.map((c) => [
    PRETTY[c],
    `${cfg[c]["latency_ms"].p50.toFixed(2)} ms`,
    `${cfg[c]["latency_ms"].mean.toFixed(2)} ms`,
    LATENCY_NOTE[c],
  ]),
});
body(
  "Brute-force cosine is fine at ~48 memories per user and will not be at 100k. An ANN index keyed by userId is the first thing to add " +
    "before this is load-bearing. These timings exclude HTTP, ingestion, and embedding the query (~50 ms on this CPU).",
  { size: 8.6, color: MUTED },
);

// ---- analysis
doc.addPage();
h1("5. What the numbers say");

h2("The v1 retriever was not retrieval");
body(
  `v1 scored ${pct(v1)} Recall@1 and ${pct(cfg["keyword-v1"]["recall@20"].mean)} Recall@20. It searched for the literal question string inside a memory, ` +
    "which no conversation contains. In a demo with hand-written memories it looks fine; on real data it is dead. This is the most useful result in the report.",
);

h2("BM25 is the workhorse");
body(
  `Adding BM25 took Recall@1 from ${pct(v1)} to ${pct(r1Of("bm25"))} and NDCG@10 to ${pct(cfg.bm25["ndcg@10"].mean)}, with no model, no GPU, and sub-millisecond queries. ` +
    "The questions and the evidence share names, products and places, and exact term matching is very good at that. Any plan that starts with an embedding pipeline " +
    "and skips this step is spending money to lose accuracy.",
);

h2("Dense retrieval loses at rank 1, and wins exactly where you would expect");
body(
  `Vector-only scored ${pct(r1Of("vector"))} Recall@1 against ${pct(r1Of("bm25"))} for BM25 — a ${(diff("bm25", "vector") * 100).toFixed(1)} point deficit, roughly at the edge of the 95% intervals. ` +
    "The per-type table explains it: on single-session-assistant questions BM25 is perfect and the dense side drops " +
    `${((results.perType["single-session-assistant"].bm25.r1 - results.perType["single-session-assistant"].vector.r1) * 100).toFixed(0)} points, because the embedding only sees a digest of user turns and the evidence is in the assistant's reply. ` +
    `On single-session-preference questions the ranking flips: vector ${pct(results.perType["single-session-preference"].vector.r1)} against BM25 ${pct(results.perType["single-session-preference"].bm25.r1)}, ` +
    "because a preference is stated implicitly and shares no vocabulary with the question.",
);

h2("Fusion helps, but this run cannot prove it by much");
body(
  `Hybrid RRF reached ${pct(r1Of("hybrid"))} Recall@1 and ${pct(cfg.hybrid["mrr@20"].mean)} MRR@20; query expansion changes that to ${pct(r1Of("hybrid+exp"))}. ` +
    `Against BM25 alone the gain is ${(diff("hybrid", "bm25") * 100).toFixed(1)} points, well inside the ±${(cfg.hybrid["recall@1"].ci95 * 100).toFixed(1)} confidence interval. ` +
    `Where it is visible is multi-session (${pct(results.perType["multi-session"].hybrid.r1)} vs ${pct(results.perType["multi-session"].bm25.r1)} for BM25), which is the category that needs several evidence sessions. ` +
    "Reporting fusion as a big win would be overselling a real but small effect.",
);

h2("The recency prior was wrong, and tuning caught it");
body(
  `Down-weighting old sessions looked reasonable until it was measured: dev Recall@10 went ${results.tuning.recencyGrid.map((d: any) => `${d.w}→${pct(d.r10)}`).join(", ")}. ` +
    `The search selected ${results.tuning.chosen}, i.e. recency off. Most LongMemEval questions are not about the most recent thing, and a recency prior is a ` +
    "knowledge-update heuristic applied to everything. It stays off by default rather than on by intuition.",
);

h2("Query expansion is noise");
body(
  `Expanding the query with terms from the first pass moved Recall@1 by ${(diff("hybrid+exp", "hybrid") * 100).toFixed(1)} percentage points and raised median latency from ` +
    `${cfg.hybrid["latency_ms"].p50.toFixed(2)} ms to ${cfg["hybrid+exp"]["latency_ms"].p50.toFixed(2)} ms (about ${(cfg["hybrid+exp"]["latency_ms"].p50 / cfg.hybrid["latency_ms"].p50).toFixed(0)}× on this local microbenchmark). Pseudo-relevance feedback is only as good as the first pass, and when the first pass is ` +
    "already right there is nothing to recover.",
);

h2("The headline benchmark number is saturated");
body(
  `Recall@20 is ${pct(r20Of("bm25"))} for BM25, ${pct(r20Of("vector"))} for vector, and ${pct(bestR20)} for hybrid. At ~48 sessions per question, the top 20 is 42% of the corpus. ` +
    "Vendors quoting improvements on this metric are mostly quoting the ceiling. If a Benchmark section is going to mean anything, it has to lead with " +
    "Recall@1 or MRR, and it has to say which split and how many sessions per question.",
);

rule();
h2("Limitations");
bullets([
  "QA accuracy was not measured. Nothing here supports a claim that Waiter answers as well as Supermemory.",
  "One embedding model (MiniLM-L6-v2) on one machine. bge-large or E5 would likely move the dense and hybrid numbers.",
  "Session digests, not chunk-level retrieval. A long session is matched on one 1.1k-character digest, which is exactly why assistant-turn questions suffer.",
  "No cross-encoder reranker. The reranking here is rank fusion, not a learned re-scorer.",
  "'Hybrid' fuses only lexical and dense; no date-aware or entity-aware scoring is implemented.",
  "The cleaned split removed noisy sessions, making retrieval easier than the original LongMemEval-S.",
  "365 test questions gives ±3.3 points at rank 1, so single-digit deltas need more data, not more opinion.",
]);

h2("What to build next, in order");
bullets([
  "Chunk-level memories with session-level aggregation: index each turn separately and score a session by its best passage. It directly targets the assistant-turn and multi-session deficits.",
  "A cross-encoder reranker over the fused top-30. Highest leverage quality step left, no schema change.",
  "An ANN index (HNSW) keyed by userId, before any of this is called at scale.",
  "Durable storage, so a 23k-session corpus does not vanish on restart.",
  "Run the QA half with a real answerer and judge, then put a labelled number in the accuracy table.",
]);

// ---- appendix
doc.addPage();
h1("Appendix: reproducing this");
body("Everything is in the repository; no API keys are involved at any step.", { color: MUTED });
table({
  headers: ["Step", "Command"],
  widths: [150, W - 150],
  rows: [
    ["Download data", "two HuggingFace URLs, see waiter/bench/README.md"],
    ["Build embedding cache", "npx tsx bench/embed.ts"],
    ["Run the benchmark", "npx tsx bench/run.ts"],
    ["Render this PDF", "npx tsx bench/report.ts"],
  ],
});
body(
  `Configurations: ${CONFIGS.map((c) => PRETTY[c]).join(", ")}. Recency grid searched on dev at Recall@10: ` +
    `${results.tuning.recencyGrid.map((d: any) => `${d.w}=${pct(d.r10)}`).join(", ")}; selected ${results.tuning.chosen}. ` +
    `Chat logs are full transcripts per session; the dense side embeds user turns only, capped at 1,100 characters.`,
  { size: 8.4, color: MUTED },
);

// page numbers
const range = doc.bufferedPageRange();
for (let i = 0; i < range.count; i++) {
  doc.switchToPage(range.start + i);
  const bottom = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  doc
    .fillColor("#94a3b8")
    .font("Helvetica")
    .fontSize(7.5)
    .text(`Waiter · LongMemEval-S · page ${i + 1} of ${range.count}`, L, doc.page.height - 34, {
      width: W,
      align: "center",
      lineBreak: false,
    });
  doc.page.margins.bottom = bottom;
}

doc.end();
console.log("wrote", pdfPath);
